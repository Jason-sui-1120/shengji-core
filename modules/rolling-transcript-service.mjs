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

function throwIfAborted(abortSignal) {
  if (!abortSignal?.aborted) return;
  const error = new Error("rolling_correction_aborted");
  error.name = "AbortError";
  throw error;
}

/**
 * 将文件 ASR 片段严格裁到本窗口的中心提交区间。
 *
 * 时间所有权采用左闭右开区间 [start, end)：右边界上的片段属于下一窗口，
 * 绝不能以 0ms 的形式落库。这个防线保留在共享 core，而不是仅依赖 SQLite/MySQL
 * adapter，保证两个端的稳定稿时间轴语义一致。
 */
export function boundSegmentsToCommitWindow(segments, { commitStartMs = 0, commitEndMs = 0 } = {}) {
  const lowerBound = Math.max(0, Math.round(Number(commitStartMs || 0)));
  const upperBound = Math.max(lowerBound + 1, Math.round(Number(commitEndMs || lowerBound + 1)));
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const rawStartMs = Math.round(Number(segment?.startMs || 0));
      const rawEndMs = Math.max(rawStartMs + 1, Math.round(Number(segment?.endMs || 0)));
      const startMs = Math.max(lowerBound, rawStartMs);
      const endMs = Math.min(upperBound, rawEndMs);
      return { ...segment, startMs, endMs };
    })
    .filter((segment) => String(segment?.text || "").trim() && segment.endMs > segment.startMs);
}

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
    abortSignal = null,
    getHotwords = async () => "",
    applyGlossary = (text) => text,
    formatTime = (seconds) => String(seconds),
  }) {
    throwIfAborted(abortSignal);
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
      throwIfAborted(abortSignal);
      let response;
      let submissionMode = "base64";
      if (AIT_PUBLIC_BASE_URL) {
        const audioUrl = `${AIT_PUBLIC_BASE_URL.replace(/\/$/, "")}/api/audio/${encodeURIComponent(fileName)}`;
        submissionMode = "url";
        response = await this.callFileTranscriptionByUrl(audioUrl, {
          fileName, model, timeoutMs: ROLLING_ASR_URL_TIMEOUT_MS, hotword: hotwordText, abortSignal,
        });
        throwIfAborted(abortSignal);
        if (!response.ok) {
          submissionMode = "base64_fallback";
          response = await this.callFileTranscription(wav, {
            fileName, model, timeoutMs: ROLLING_ASR_TIMEOUT_MS, hotword: hotwordText, abortSignal,
          });
        }
      } else {
        response = await this.callFileTranscription(wav, {
          fileName, model, timeoutMs: ROLLING_ASR_TIMEOUT_MS, hotword: hotwordText, abortSignal,
        });
      }
      // 网络请求即使在 deadline 后才返回，也绝不能继续写入窗口审计、删除或插入。
      // 否则 realtime fallback 与迟到的文件稿会双写同一时间段。
      throwIfAborted(abortSignal);
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
        throwIfAborted(abortSignal);
        windowRunId = await this.store.createWindowRun(meetingId, {
          model, windowStartAudioMs, windowEndAudioMs,
          trimLeadingSeconds, trimTrailingSeconds, submissionMode, correctedText, result,
        });
      } catch (error) {
        console.warn(`[rolling-asr] audit persist failed meeting=${meetingId}: ${error instanceof Error ? error.message : String(error)}`);
      }

      throwIfAborted(abortSignal);
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
      // 必须传 effective 中心提交区间——否则落库退回请求上下文范围，
      // 前置 8 秒重叠区会被当作稳定稿重复插入（银标重复主因之一）。
      if (!candidateRows.length) {
        const inserted = await this.insertFileAsrSegments({
          meetingId,
          fileResult: result,
          trimLeadingSeconds,
          trimTrailingSeconds,
          windowStartAudioMs,
          windowEndAudioMs,
          effectiveWindowStartMs,
          effectiveWindowEndMs,
          previousStableText,
          sourceSpeechIntervals,
          speakerRows: rows,
          model,
          hotwords: hotwordText ? hotwordText.split(",").filter(Boolean) : [],
          abortSignal,
        });
        if (windowRunId) await this.store.finalizeWindowRun(windowRunId, "file_timing", inserted.insertedCount, null);
        // 直接插入的文件稿同样已经是新的稳定事实。必须触发后续自动分析，
        // 否则界面会出现“已校准”但实时总结长期停在“等待首条稳定转写”。
        if (inserted.insertedCount > 0) {
          await this.afterStableCorrection(meetingId, inserted.stableRevision);
        }
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
          stableRevision: inserted.stableRevision,
          reason: inserted.insertedCount ? "file_segments_inserted" : (rows.length ? "no_transcript_rows_in_window" : "no_transcript_rows"),
          alignmentMode: "file_timing",
          windowStartAudioMs,
          windowEndAudioMs,
          commitEndAudioMs: effectiveWindowEndMs,
          forcedBoundary,
        };
      }

      // 有候选行：对齐文件稿 → 声纹分离投射说话人 → 原子应用稳定稿校正。
      // 必须传 effective 中心提交区间（commitStartMs/commitEndMs）——
      // 否则对齐层把请求上下文起点当提交起点，前一窗口重叠内容会拼进本窗稳定稿。
      const alignment = await alignRollingCorrectionToRows(candidateRows, correctedText, result, trimLeadingSeconds, {
        windowStartAudioMs,
        windowEndAudioMs,
        trimTrailingSeconds,
        previousStableText,
        commitStartMs: effectiveWindowStartMs,
        commitEndMs: effectiveWindowEndMs,
        sourceSpeechIntervals,
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
          speakerRows: candidateRows,
          model,
          hotwords: hotwordText ? hotwordText.split(",").filter(Boolean) : [],
          abortSignal,
        });
        if (!replacement.insertedCount) throw new Error("unable to align corrected transcript to rows");
        if (windowRunId) await this.store.finalizeWindowRun(windowRunId, "file_replace_fallback", replacement.insertedCount, replacement.compositionTrace);
        await this.afterStableCorrection(meetingId, replacement.stableRevision);
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
          stableRevision: replacement.stableRevision,
          alignmentMode: "file_replace_fallback",
          consistency: "disputed",
          windowStartAudioMs,
          windowEndAudioMs,
          commitEndAudioMs: effectiveWindowEndMs,
        };
      }

      throwIfAborted(abortSignal);
      const diarizationSegments = this.diarizeSpeakerSegments
        ? await this.diarizeSpeakerSegments({ meetingId, wav, audioPath })
        : [];
      // 对齐器可能只覆盖候选行的一部分（例如实时端把一句拆成了多行）。
      // 只有真正收到文件稿映射的行才能进入 stable；此前把整个 candidateRows
      // 都标 stable，会把未覆盖的实时残片伪装成定稿，随后与文件稿并排保留，
      // 造成重复文本和稳定稿评分虚高。
      const matchedCandidateRows = getMappedCandidateRows(candidateRows, aligned);
      // 对齐只覆盖了一部分实时草稿时，不能把“已映射部分”更新为 stable、
      // 其余草稿无限遗留到封存时再全部降级成 fallback。那样同一段时间会同时
      // 存在文件稿和实时残片，最终拼接必然重复。
      //
      // 文件窗口已经成功返回可用结果，因此此时以该窗口的 canonical 文件稿整体
      // 替换未人工编辑的自动行；人工编辑行仍由 store 的保护条件保留。这比让
      // 未映射残片在后续窗口/封存阶段不断累积更可预测，也符合“稳定稿优先”的
      // 单一事实来源约束。
      if (shouldReplaceWindowForPartialAlignment(candidateRows, aligned)) {
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
          speakerRows: candidateRows,
          model,
          hotwords: hotwordText ? hotwordText.split(",").filter(Boolean) : [],
          abortSignal,
        });
        if (replacement.insertedCount > 0) {
          if (windowRunId) await this.store.finalizeWindowRun(windowRunId, "file_replace_partial_alignment", replacement.insertedCount, replacement.compositionTrace);
          await this.afterStableCorrection(meetingId, replacement.stableRevision);
          return {
            ok: true,
            updatedCount: 0,
            insertedCount: replacement.insertedCount,
            skippedCount: 0,
            lastProcessedTranscriptId: replacement.lastTranscriptId || Number(startTranscriptId || 0),
            model,
            submissionMode,
            sourceLength: correctedText.length,
            hotwordCount,
            hotwordChars: hotwordText.length,
            stableRevision: replacement.stableRevision,
            alignmentMode: "file_replace_partial_alignment",
            consistency: "disputed",
            windowStartAudioMs,
            windowEndAudioMs,
            commitEndAudioMs: effectiveWindowEndMs,
            unmatchedCandidateCount: Math.max(0, candidateRows.length - matchedCandidateRows.length),
          };
        }
        console.warn(`[rolling-asr] partial alignment replacement produced no canonical segments meeting=${meetingId}; preserving mapped-row fallback`);
      }
      const diarizedSpeakers = mapDiarizationSpeakersToRows(matchedCandidateRows, aligned, diarizationSegments, wav.length / (16000 * 2), trimLeadingSeconds);

      throwIfAborted(abortSignal);
      const applied = await this.store.applyStableCorrection(meetingId, {
        candidateRows: matchedCandidateRows,
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
        unmatchedCandidateCount: Math.max(0, candidateRows.length - matchedCandidateRows.length),
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
    speakerRows = [],
    model = ROLLING_ASR_MODEL,
    hotwords = [],
    glossaryEntries = [],
    abortSignal = null,
  }) {
    throwIfAborted(abortSignal);
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
    throwIfAborted(abortSignal);
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
      speakerRows,
      model,
      hotwords,
      glossaryEntries,
      auditTrace: {},
      abortSignal,
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
    speakerRows = [],
    model = ROLLING_ASR_MODEL,
    hotwords = [],
    auditTrace = {},
    glossaryEntries = [],
    audioPath = "",
    abortSignal = null,
  }) {
    throwIfAborted(abortSignal);
    const commitStartMs = Number(effectiveWindowStartMs || 0) > 0
      ? Number(effectiveWindowStartMs)
      : Number(windowStartAudioMs || 0) + Math.max(0, Number(trimLeadingSeconds || 0)) * 1000;
    const commitEndMs = Number(effectiveWindowEndMs || 0) > commitStartMs
      ? Number(effectiveWindowEndMs)
      : Number(windowEndAudioMs || Number.MAX_SAFE_INTEGER) - Math.max(0, Number(trimTrailingSeconds || 0)) * 1000;

    const candidateSegments = applySpeakerHintsToFileSegments(getAbsoluteFileSegments(
      fileResult,
      trimLeadingSeconds,
      windowStartAudioMs,
      previousStableText,
      trimTrailingSeconds,
      Math.max(0, Number(windowEndAudioMs || 0) - Number(windowStartAudioMs || 0)),
      { sourceSpeechIntervals, commitStartMs, commitEndMs, auditTrace },
    ), speakerRows).map((segment) => ({
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
    throwIfAborted(abortSignal);
    const boundedSegments = boundSegmentsToCommitWindow(segments, { commitStartMs, commitEndMs });
    if (!boundedSegments.length) {
      return {
        insertedCount: 0,
        insertedIds: [],
        stableRevision: 0,
        lastTranscriptId: 0,
        compositionTrace: {
          commitStartMs, commitEndMs, timing: auditTrace,
          candidates: candidateSegments.map(summarizeCompositionSegment),
          canonical: segments.map(summarizeCompositionSegment),
          inserted: [],
        },
      };
    }

    const { insertedCount, insertedIds, stableRevision } = await this.store.insertFileAsrStableSegments(meetingId, {
      segments: boundedSegments.map((segment) => ({
        time: formatMeetingElapsedTime(segment.startMs / 1000),
        speaker: segment.speaker || "待识别",
        text: segment.text,
        speakerSource: segment.speakerSource || "file_asr",
        startMs: segment.startMs,
        endMs: segment.endMs,
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
      stableRevision: Number(stableRevision || 0),
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

/**
 * 仅返回实际拿到文件稿映射的实时候选行。
 * 未映射行仍保留 draft，等待下一窗口或封存补偿，绝不能提前标记成 stable。
 */
export function getMappedCandidateRows(candidateRows = [], aligned = []) {
  // `alignFileSegmentsToRowsByAbsoluteTime` 会为每一条候选行生成结果；未命中
  // 文件段的行只是 `fileSegmentCount: 0` 的占位项，不能被误认为已校准。
  // 其他对齐模式（single/timing_fallback）没有该字段，表示它们确实为整批行
  // 分配了文件稿，仍按原有语义全部视为已映射。
  const hasFileSegmentEvidence = aligned.some((item) => Object.hasOwn(item || {}, "fileSegmentCount"));
  const alignedRowIds = new Set(aligned
    .filter((item) => !hasFileSegmentEvidence || Number(item?.fileSegmentCount || 0) > 0)
    .map((item) => Number(item?.id))
    .filter(Number.isFinite));
  return candidateRows.filter((row) => alignedRowIds.has(Number(row?.id)));
}

/**
 * 文件稿已经可用但无法覆盖所有自动草稿时，必须整体替换这个稳定窗口。
 * 否则未覆盖的草稿会在封存阶段被降级为 fallback，与文件稿并列导致重复。
 */
export function shouldReplaceWindowForPartialAlignment(candidateRows = [], aligned = []) {
  const candidates = Array.isArray(candidateRows) ? candidateRows : [];
  if (!candidates.length) return false;
  return getMappedCandidateRows(candidates, aligned).length < candidates.length;
}

/**
 * 文件 ASR 的文本是窗口的唯一稳定事实，但它通常不带可展示的说话人名称。
 * 在整体替换自动行前，把同一绝对时间轴上已有的、非“待识别”的说话人作为
 * 保守提示继承下来：不改变人工标注，也不伪造新的声纹识别结果。
 */
export function applySpeakerHintsToFileSegments(segments = [], speakerRows = []) {
  const usableRows = (Array.isArray(speakerRows) ? speakerRows : [])
    .map((row) => ({
      speaker: String(row?.speaker || "").trim(),
      speakerSource: String(row?.speakerSource || row?.speaker_source || "").trim(),
      speakerConfidence: Number(row?.speakerConfidence ?? row?.speaker_confidence ?? 0),
      startMs: Number(row?.audioStartMs ?? row?.audio_start_ms ?? 0),
      endMs: Number(row?.audioEndMs ?? row?.audio_end_ms ?? 0),
    }))
    .filter((row) => row.speaker && row.speaker !== "待识别" && row.endMs > row.startMs);
  if (!usableRows.length) return Array.isArray(segments) ? segments : [];

  return (Array.isArray(segments) ? segments : []).map((segment) => {
    const startMs = Number(segment?.startMs || 0);
    const endMs = Number(segment?.endMs || 0);
    let winner = null;
    let bestOverlap = 0;
    for (const row of usableRows) {
      const overlap = Math.max(0, Math.min(endMs, row.endMs) - Math.max(startMs, row.startMs));
      if (overlap > bestOverlap || (overlap === bestOverlap && winner && row.speakerConfidence > winner.speakerConfidence)) {
        winner = row;
        bestOverlap = overlap;
      }
    }
    if (!winner || bestOverlap <= 0) return segment;
    return {
      ...segment,
      speaker: winner.speaker,
      speakerSource: winner.speakerSource || "rolling_realtime_hint",
      speakerConfidence: winner.speakerConfidence || undefined,
    };
  });
}
