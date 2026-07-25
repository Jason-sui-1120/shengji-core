/**
 * rolling-transcript-service.mjs —— 滚动转写服务（纯业务逻辑，async）。
 * 只依赖 RollingStore 接口，不接触 openDb/方言 SQL/事务。
 * 旧 rolling-asr（index.mjs 里的函数）不动，本服务是新入口。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { audioDir } from "./env.mjs";
import { wrapPcm16AsWav } from "./audio-utils.mjs";
import { normalizeTranscriptSegment } from "./text-utils.mjs";
import { composeCanonicalFileSegments } from "./transcript-composer.mjs";
import { computeTranscriptCoverage, planCoverageRepairWindows } from "./transcript-coverage.mjs";
import { getAbsoluteFileSegments, getCharOverlapRatio, summarizeCompositionSegment, formatMeetingElapsedTime, getFileTimestampScale, normalizeFileTimestamp } from "./file-segments.mjs";
import { applyGlossaryAliasCorrections } from "./glossary-text.mjs";
import {
  isUsableTranscriptCorrection, extractStableWindowText,
  alignRollingCorrectionToRows, alignFileSegmentsToRowsByAbsoluteTime,
  longestCommonSubsequenceLength, alignFileTextByTiming,
  mapDiarizationSpeakersToRows, removeFillerWords, mergeTranscriptText,
} from "./transcript-align.mjs";
import {
  AIT_PUBLIC_BASE_URL, ROLLING_ASR_TIMEOUT_MS, ROLLING_ASR_URL_TIMEOUT_MS,
  ROLLING_ASR_MODEL, ROLLING_ASR_MIN_WINDOW_OVERLAP_RATIO,
} from "./config.mjs";

/**
 * RollingTranscriptService：滚动 ASR 稳定稿校正服务。
 * 依赖注入 RollingStore（SQLite/MySQL 各自实现）+ AI 调用函数（callFileTranscription 等），
 * 业务逻辑两端共用。AI 调用通过构造函数注入，不直接 import（保持服务独立）。
 */
export class RollingTranscriptService {
  constructor(store, aiCalls = {}) {
    this.store = store;
    // AI 调用注入（callFileTranscription/callFileTranscriptionByUrl/diarizeSpeakerSegments）
    this.callFileTranscription = aiCalls.callFileTranscription;
    this.callFileTranscriptionByUrl = aiCalls.callFileTranscriptionByUrl;
    this.diarizeSpeakerSegments = aiCalls.diarizeSpeakerSegments || null;
    // 旧链路副作用注入（快照刷新/自动分析调度），切换生产时由调用方提供。
    // 默认空操作（不阻塞服务自身逻辑，也不强依赖 index.mjs）。
    this.afterStableCorrection = typeof aiCalls.afterStableCorrection === "function"
      ? aiCalls.afterStableCorrection
      : async () => {};
  }

  /**
   * 滚动校正一个窗口的转写。
   * 业务逻辑与 index.mjs 的 performRollingTranscriptCorrection 一致，
   * 但 DB 操作全部通过 this.store。
   */
  async correctWindow({
    meetingId,
    pcm,
    startTranscriptId,
    endTranscriptId,
    model = ROLLING_ASR_MODEL,
    trimLeadingSeconds = 0,
    trimTrailingSeconds = 0,
    windowStartAudioMs = 0,
    windowEndAudioMs = 0,
    centerStartAudioMs = 0,
    centerEndAudioMs = 0,
    sourceSpeechIntervals = [],
    forcedBoundary = false,
    allowBoundaryRows = false,
    getHotwords = async () => "",
    applyGlossary = (text) => text,
    formatTime = (seconds) => String(seconds),
  }) {
    const wav = wrapPcm16AsWav(pcm, 16000);
    const requestDurationSeconds = pcm.length / (16000 * 2);
    const fileName = `meeting-${Number(meetingId || 1)}-rolling-${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
    const audioPath = path.join(audioDir, fileName);
    // 公司端部署不会预建 audio 目录（源音频走 tmpdir 缓存），写滚动 WAV 前必须确保目录存在。
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    fs.writeFileSync(audioPath, wav);

    let hotwordText = "";
    let hotwordCount = 0;
    try {
      const terms = await getHotwords(meetingId);
      hotwordCount = terms.length;
      if (terms.length) hotwordText = terms.join(",");
    } catch { /* ignore glossary errors */ }

    try {
      let response;
      let submissionMode = "base64";
      if (AIT_PUBLIC_BASE_URL) {
        const audioUrl = `${AIT_PUBLIC_BASE_URL.replace(/\/$/, "")}/api/audio/${encodeURIComponent(fileName)}`;
        submissionMode = "url";
        response = await this.callFileTranscriptionByUrl(audioUrl, { fileName, model, timeoutMs: ROLLING_ASR_URL_TIMEOUT_MS, hotword: hotwordText });
        if (!response.ok) {
          submissionMode = "base64_fallback";
          response = await this.callFileTranscription(wav, { fileName, model, timeoutMs: ROLLING_ASR_TIMEOUT_MS, hotword: hotwordText });
        }
      } else {
        response = await this.callFileTranscription(wav, { fileName, model, timeoutMs: ROLLING_ASR_TIMEOUT_MS, hotword: hotwordText });
      }
      if (!response.ok) throw new Error(`file transcription failed: ${response.text.slice(0, 500)}`);
      const payload = JSON.parse(response.text);
      const result = payload?.result || payload?.data?.result || payload?.data || payload;

      const plannedCommitEndMs = Math.round(Number(centerEndAudioMs || windowEndAudioMs));
      trimTrailingSeconds = Math.max(0, Number(windowEndAudioMs || 0) - plannedCommitEndMs) / 1000;
      const correctedText = extractStableWindowText(result, trimLeadingSeconds, trimTrailingSeconds, requestDurationSeconds);
      if (!correctedText) throw new Error("file transcription returned empty text");
      const effectiveWindowStartMs = Math.round(Number(centerStartAudioMs || (Number(windowStartAudioMs || 0) + Math.max(0, Number(trimLeadingSeconds || 0)) * 1000)));
      const effectiveWindowEndMs = plannedCommitEndMs;

      let windowRunId = 0;
      try {
        windowRunId = await this.store.createWindowRun(meetingId, {
          model, windowStartAudioMs, windowEndAudioMs,
          trimLeadingSeconds, trimTrailingSeconds, submissionMode, correctedText, result,
        });
      } catch (error) {
        console.warn(`[rolling-asr] audit persist failed meeting=${meetingId}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const rows = await this.store.listWindowTranscriptRows(meetingId, effectiveWindowStartMs, effectiveWindowEndMs, startTranscriptId, endTranscriptId);
      const previousStableText = await this.store.getPreviousStableText(meetingId, effectiveWindowStartMs);

      // 候选行过滤：与公网端 performRollingTranscriptCorrection 一致。
      // 有有效时长的行必须主要内容落在本窗口内（或允许边界行时只要有重叠），
      // 避免把整段 45 秒文件稿摊进一条 0.2 秒的实时行。
      const hasTimedRows = rows.some((row) => Number(row.audioStartMs || 0) > 0 || Number(row.audioEndMs || 0) > 0);
      const candidateRows = rows.filter((row) => {
        if (!hasTimedRows) return Number(row.id) > Number(startTranscriptId || 0) && Number(row.id) <= Number(endTranscriptId || Number.MAX_SAFE_INTEGER);
        const start = Number(row.audioStartMs || 0);
        const end = Number(row.audioEndMs || 0);
        const windowEnd = Number(effectiveWindowEndMs || Number.MAX_SAFE_INTEGER);
        if (end === start) return false;
        if (end < start) return false;
        const overlap = Math.max(0, Math.min(end, windowEnd) - Math.max(start, effectiveWindowStartMs));
        const overlapRatio = overlap / Math.max(1, end - start);
        if (allowBoundaryRows) return overlap > 0;
        return overlapRatio >= ROLLING_ASR_MIN_WINDOW_OVERLAP_RATIO;
      }).sort((a, b) => {
        const aStart = Number(a.audioStartMs || 0);
        const bStart = Number(b.audioStartMs || 0);
        return aStart - bStart || Number(a.id) - Number(b.id);
      });

      // 无候选行（或没有实时草稿行）：直接插入文件 ASR 段为稳定稿。
      if (!candidateRows.length) {
        const inserted = await this.insertFileAsrSegments({
          meetingId,
          fileResult: result,
          trimLeadingSeconds,
          trimTrailingSeconds,
          windowStartAudioMs,
          windowEndAudioMs,
          previousStableText,
          sourceSpeechIntervals,
          model,
          hotwords: hotwordText ? hotwordText.split(",").filter(Boolean) : [],
        });
        if (windowRunId) await this.store.finalizeWindowRun(windowRunId, "file_timing", inserted.insertedCount, null);
        return {
          ok: true,
          updatedCount: 0,
          insertedCount: inserted.insertedCount,
          skippedCount: 0,
          lastProcessedTranscriptId: inserted.lastTranscriptId || Number(startTranscriptId || 0),
          model,
          submissionMode,
          hotwordCount,
          hotwordChars: hotwordText.length,
          reason: inserted.insertedCount ? "file_segments_inserted" : (rows.length ? "no_transcript_rows_in_window" : "no_transcript_rows"),
          alignmentMode: "file_timing",
          windowStartAudioMs,
          windowEndAudioMs,
          commitEndAudioMs: effectiveWindowEndMs,
          forcedBoundary,
        };
      }

      // 有候选行：对齐文件稿 → 声纹分离投射说话人 → 原子应用稳定稿校正。
      const alignment = await alignRollingCorrectionToRows(candidateRows, correctedText, result, trimLeadingSeconds, {
        windowStartAudioMs,
        windowEndAudioMs,
        trimTrailingSeconds,
        previousStableText,
      });
      const aligned = alignment.lines;
      if (!aligned.length) {
        // 实时草稿与文件稿差异很大时，不能让一个可用的文件 ASR 窗口反复失败。
        // 直接以带时间戳的文件稿替换当前未人工编辑的草稿，既保留时间轴，也
        // 避免会议一直卡在“待稳定校准”。人工编辑行由 store 的保护条件保留。
        const replacement = await this.replaceWindowWithFileSegments({
          meetingId,
          fileResult: result,
          trimLeadingSeconds,
          trimTrailingSeconds,
          windowStartAudioMs,
          windowEndAudioMs,
          effectiveWindowStartMs,
          effectiveWindowEndMs,
          sourceSpeechIntervals,
          previousStableText,
          model,
          hotwords: hotwordText ? hotwordText.split(",").filter(Boolean) : [],
        });
        if (!replacement.insertedCount) throw new Error("unable to align corrected transcript to rows");
        if (windowRunId) await this.store.finalizeWindowRun(windowRunId, "file_replace_fallback", replacement.insertedCount, replacement.compositionTrace);
        await this.afterStableCorrection(meetingId, 0);
        return {
          ok: true,
          updatedCount: 0,
          insertedCount: replacement.insertedCount,
          skippedCount: candidateRows.length,
          lastProcessedTranscriptId: replacement.lastTranscriptId || Number(startTranscriptId || 0),
          model,
          submissionMode,
          sourceLength: correctedText.length,
          hotwordCount,
          hotwordChars: hotwordText.length,
          alignmentMode: "file_replace_fallback",
          consistency: "disputed",
          windowStartAudioMs,
          windowEndAudioMs,
          commitEndAudioMs: effectiveWindowEndMs,
        };
      }

      const diarizationSegments = this.diarizeSpeakerSegments
        ? await this.diarizeSpeakerSegments({ meetingId, wav, audioPath })
        : [];
      const diarizedSpeakers = mapDiarizationSpeakersToRows(candidateRows, aligned, diarizationSegments, wav.length / (16000 * 2), trimLeadingSeconds);

      const applied = await this.store.applyStableCorrection(meetingId, {
        candidateRows,
        aligned,
        diarizedSpeakers,
        alignment,
        model,
        applyGlossary,
        formatTime,
      });

      if (windowRunId) await this.store.finalizeWindowRun(windowRunId, alignment.mode, applied.updatedCount, null);

      // 旧链路副作用：快照刷新 + 自动分析调度（由调用方注入，默认空操作）。
      await this.afterStableCorrection(meetingId, applied.stableRevision);

      return {
        ok: true,
        updatedCount: applied.updatedCount,
        skippedCount: applied.skippedCount,
        speakerUpdatedCount: applied.speakerUpdatedCount,
        lastProcessedTranscriptId: Math.max(Number(startTranscriptId || 0), ...candidateRows.map((row) => Number(row.id))),
        model,
        submissionMode,
        sourceLength: correctedText.length,
        hotwordCount,
        hotwordChars: hotwordText.length,
        stableRevision: applied.stableRevision,
        alignmentMode: alignment.mode,
        consistency: alignment.consistency,
        windowStartAudioMs,
        windowEndAudioMs,
        commitEndAudioMs: effectiveWindowEndMs,
      };
    } finally {
      // 临时文件清理由调用方或定时任务处理（与现有行为一致）
    }
  }

  /**
   * 用文件 ASR 段替换滚动窗口（迁移 replaceRollingWindowWithFileSegments 业务逻辑）。
   * 删除窗口内旧段 + 插入新的 canonical 段。
   */
  async replaceWindowWithFileSegments({
    meetingId,
    fileResult,
    trimLeadingSeconds = 0,
    trimTrailingSeconds = 0,
    windowStartAudioMs = 0,
    windowEndAudioMs = 0,
    effectiveWindowStartMs = 0,
    effectiveWindowEndMs = 0,
    sourceSpeechIntervals = [],
    previousStableText = "",
    model = ROLLING_ASR_MODEL,
    hotwords = [],
    glossaryEntries = [],
  }) {
    const previewAuditTrace = {};
    const preview = getAbsoluteFileSegments(
      fileResult,
      trimLeadingSeconds,
      windowStartAudioMs,
      previousStableText,
      trimTrailingSeconds,
      Math.max(0, Number(windowEndAudioMs || 0) - Number(windowStartAudioMs || 0)),
      {
        sourceSpeechIntervals,
        commitStartMs: effectiveWindowStartMs,
        commitEndMs: effectiveWindowEndMs,
        auditTrace: previewAuditTrace,
      },
    );
    if (!preview.length) return { insertedCount: 0, deletedCount: 0, lastTranscriptId: 0 };

    // 删除窗口内旧段（通过 store，事务）
    const deletedCount = await this.store.deleteWindowTranscriptRows(meetingId, effectiveWindowStartMs, effectiveWindowEndMs);

    // 插入新的 canonical 段
    const inserted = await this.insertFileAsrSegments({
      meetingId,
      fileResult,
      trimLeadingSeconds,
      trimTrailingSeconds,
      windowStartAudioMs,
      windowEndAudioMs,
      effectiveWindowStartMs,
      effectiveWindowEndMs,
      previousStableText,
      sourceSpeechIntervals,
      model,
      hotwords,
      glossaryEntries,
      auditTrace: {},
    });

    return {
      ...inserted,
      deletedCount,
      compositionTrace: {
        version: 1,
        effectiveWindowStartMs: Math.round(Number(effectiveWindowStartMs || 0)),
        effectiveWindowEndMs: Math.round(Number(effectiveWindowEndMs || 0)),
        previewTiming: previewAuditTrace,
        preview: preview.map(summarizeCompositionSegment),
        deletedCount,
        insertion: inserted.compositionTrace || {},
      },
    };
  }

  /**
   * 插入文件 ASR 稳定片段（迁移 insertFileAsrSegmentsAsStable 业务逻辑）。
   * 重叠保护 + 窗口内单调化，DB 操作通过 store。
   */
  async insertFileAsrSegments({
    meetingId,
    fileResult,
    trimLeadingSeconds = 0,
    trimTrailingSeconds = 0,
    windowStartAudioMs = 0,
    windowEndAudioMs = Number.MAX_SAFE_INTEGER,
    effectiveWindowStartMs = 0,
    effectiveWindowEndMs = 0,
    previousStableText = "",
    sourceSpeechIntervals = [],
    model = ROLLING_ASR_MODEL,
    hotwords = [],
    auditTrace = {},
    glossaryEntries = [],
    audioPath = "",
  }) {
    const commitStartMs = Number(effectiveWindowStartMs || 0) > 0
      ? Number(effectiveWindowStartMs)
      : Number(windowStartAudioMs || 0) + Math.max(0, Number(trimLeadingSeconds || 0)) * 1000;
    const commitEndMs = Number(effectiveWindowEndMs || 0) > commitStartMs
      ? Number(effectiveWindowEndMs)
      : Number(windowEndAudioMs || Number.MAX_SAFE_INTEGER) - Math.max(0, Number(trimTrailingSeconds || 0)) * 1000;

    const candidateSegments = getAbsoluteFileSegments(
      fileResult,
      trimLeadingSeconds,
      windowStartAudioMs,
      previousStableText,
      trimTrailingSeconds,
      Math.max(0, Number(windowEndAudioMs || 0) - Number(windowStartAudioMs || 0)),
      { sourceSpeechIntervals, commitStartMs, commitEndMs, auditTrace },
    ).map((segment) => ({
      ...segment,
      text: applyGlossaryAliasCorrections(segment.text, glossaryEntries) || segment.text,
      startMs: Math.max(0, Number(segment.startMs || 0)),
      endMs: Math.min(Number(windowEndAudioMs || Number.MAX_SAFE_INTEGER), Number(segment.endMs || 0)),
    })).filter((segment) => segment.text && segment.endMs > segment.startMs);

    if (!candidateSegments.length) {
      return {
        insertedCount: 0,
        insertedIds: [],
        lastTranscriptId: 0,
        compositionTrace: { commitStartMs, commitEndMs, timing: auditTrace, candidates: [], canonical: [], inserted: [] },
      };
    }

    const segments = composeCanonicalFileSegments(candidateSegments, {
      windowStartMs: commitStartMs,
      windowEndMs: Math.max(commitStartMs + 1, commitEndMs),
      protectedRows: [],
      precedingRows: [],
    });

    if (!segments.length) {
      return {
        insertedCount: 0,
        insertedIds: [],
        lastTranscriptId: 0,
        compositionTrace: {
          commitStartMs, commitEndMs, timing: auditTrace,
          candidates: candidateSegments.map(summarizeCompositionSegment),
          canonical: [], inserted: [],
        },
      };
    }

    // DB 插入通过 store（含重叠保护 + 事务）
    const { insertedCount, insertedIds } = await this.store.insertFileAsrStableSegments(meetingId, {
      segments: segments.map((segment) => ({
        time: formatMeetingElapsedTime(segment.startMs / 1000),
        speaker: segment.speaker || "待识别",
        text: segment.text,
        speakerSource: "file_asr",
        startMs: Math.max(commitStartMs, Math.round(segment.startMs)),
        endMs: Math.min(commitEndMs, Math.max(Math.round(segment.endMs), Math.round(segment.startMs) + 1)),
      })),
      protectedRows: [],
      precedingRows: [],
      model,
      audioPath,
      windowStartMs: commitStartMs,
      windowEndMs: commitEndMs,
    });

    return {
      insertedCount,
      insertedIds,
      lastTranscriptId: insertedIds[insertedIds.length - 1] || 0,
      compositionTrace: {
        commitStartMs, commitEndMs, timing: auditTrace,
        candidates: candidateSegments.map(summarizeCompositionSegment),
        canonical: segments.map(summarizeCompositionSegment),
        inserted: [],
      },
    };
  }
}
