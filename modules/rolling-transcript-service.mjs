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
import {
  buildAbsoluteTimedWords,
  composeCanonicalFileSegments,
  planSpeakerTurnSplits,
} from "./transcript-composer.mjs";
import { computeTranscriptCoverage, planCoverageRepairWindows } from "./transcript-coverage.mjs";
import { getAbsoluteFileSegments, getCharOverlapRatio, summarizeCompositionSegment, formatMeetingElapsedTime, getFileTimestampScale, normalizeFileTimestamp } from "./file-segments.mjs";
import { applyGlossaryAliasCorrections } from "./glossary-text.mjs";
import { extractStableWindowText, splitTextByWeights } from "./transcript-align.mjs";
import {
  assignSpeakersByAbsoluteOverlap,
  buildAbsoluteSpeakerSegments,
} from "./speaker-timeline.mjs";
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
 * 文件转写服务的响应并不保证总能提供可用的 segments/words 时间戳：有些成功
 * 响应只有全文 text。不能一方面接受这种结果，另一方面又因为不能生成 canonical
 * 段而让整窗稳定稿失败。这里保守地复用浏览器实时 ASR 已经落下的 VAD 时间轴，
 * 只把“文字事实”替换为文件 ASR 的文字；不猜测新的音频时间，也不使用 LLM 改写。
 */
export function buildFileTextTimingFallbackSegments(text, speakerRows = [], {
  commitStartMs = 0,
  commitEndMs = 0,
} = {}) {
  const normalizedText = normalizeTranscriptSegment(text);
  const lowerBound = Math.max(0, Math.round(Number(commitStartMs || 0)));
  const upperBound = Math.max(lowerBound + 1, Math.round(Number(commitEndMs || lowerBound + 1)));
  if (!normalizedText) return [];

  const timedRows = (Array.isArray(speakerRows) ? speakerRows : [])
    .map((row) => {
      const rawStartMs = Math.round(Number(row?.audioStartMs ?? row?.audio_start_ms ?? 0));
      const rawEndMs = Math.round(Number(row?.audioEndMs ?? row?.audio_end_ms ?? 0));
      return {
        startMs: Math.max(lowerBound, rawStartMs),
        endMs: Math.min(upperBound, rawEndMs),
        speaker: String(row?.speaker || "").trim(),
        speakerSource: String(row?.speakerSource ?? row?.speaker_source ?? "").trim(),
        speakerConfidence: Number(row?.speakerConfidence ?? row?.speaker_confidence ?? 0),
      };
    })
    .filter((row) => row.endMs > row.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  // 在实时草稿尚未来得及落库的极早窗口，仍让文件稿作为一条稳定记录落轴；
  // 使用提交区间而非凭空生成更细的句子时间。
  if (!timedRows.length) {
    return [{
      text: normalizedText,
      startMs: lowerBound,
      endMs: upperBound,
      timestampMode: "realtime_timing_fallback",
    }];
  }

  const pieces = splitTextByWeights(
    normalizedText,
    timedRows.map((row) => Math.max(1, row.endMs - row.startMs)),
  );
  return timedRows
    .map((row, index) => ({
      ...row,
      text: normalizeTranscriptSegment(pieces[index]),
      timestampMode: "realtime_timing_fallback",
    }))
    .filter((segment) => segment.text && segment.endMs > segment.startMs);
}

function summarizeFileAsrResultShape(result) {
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const words = Array.isArray(result?.words) ? result.words : [];
  const hasTimedRange = (item) => {
    const start = Number(item?.start ?? item?.start_time ?? item?.startTime);
    const end = Number(item?.end ?? item?.end_time ?? item?.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && end > start;
  };
  const hasText = (item) => normalizeTranscriptSegment(item?.text ?? item?.word ?? item?.token).length > 0;
  return {
    keys: Object.keys(result || {}).sort().slice(0, 12),
    textChars: normalizeTranscriptSegment(result?.text).length,
    segmentCount: segments.length,
    segmentTextCount: segments.filter(hasText).length,
    segmentTimedCount: segments.filter((item) => hasText(item) && hasTimedRange(item)).length,
    wordCount: words.length,
    wordTimedCount: words.filter((item) => hasText(item) && hasTimedRange(item)).length,
  };
}

/**
 * RollingTranscriptService：滚动 ASR 稳定稿校正服务。
 * 依赖注入 RollingStore（SQLite/MySQL 各自实现）+ AI 调用函数（callFileTranscription 等），
 * 业务逻辑两端共用。AI 调用通过构造函数注入，不直接 import（保持服务独立）。
 */
export class RollingTranscriptService {
  constructor(store, aiCalls = {}) {
    this.store = store;
    // AI 调用注入（callFileTranscription/callFileTranscriptionByUrl）。
    // 说话人分离只在稳定稿落库后异步回填，绝不阻塞文件稿成为稳定文本。
    this.callFileTranscription = aiCalls.callFileTranscription;
    this.callFileTranscriptionByUrl = aiCalls.callFileTranscriptionByUrl;
    this.diarizeSpeakerSegments = typeof aiCalls.diarizeSpeakerSegments === "function"
      ? aiCalls.diarizeSpeakerSegments
      : null;
    this.resolveDiarizedSpeakerTracks = typeof aiCalls.resolveDiarizedSpeakerTracks === "function"
      ? aiCalls.resolveDiarizedSpeakerTracks
      : null;
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

      // 稳定稿只认文件 ASR：无论实时草稿是否恰好能文本对齐，成功返回的文件稿
      // 都以同一条 canonical 路径原子替换本窗口内未人工编辑的自动行。
      //
      // 旧的三分支（无候选直接插入 / 部分对齐替换 / 完整对齐就地改写）会让同一
      // 个文件窗口因实时草稿形态不同走出不同的落库语义。最坏情况下先删草稿、
      // 后插文件稿不在同一事务，出现“草稿消失”或“只剩 realtime_fallback”。
      // 统一替换后，实时 ASR 只承担低延迟预览和说话人提示；文件 ASR 才是稳定
      // 文本的唯一事实来源。人工编辑行继续由 adapter 的 user_edited 保护条件保留。
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
        fallbackText: correctedText,
        model,
        hotwords: hotwordText ? hotwordText.split(",").filter(Boolean) : [],
        audioPath,
        abortSignal,
      });
      if (!replacement.insertedCount) {
        // 只记录响应形状和计数，不记录用户会议文本或音频内容；这样线上能区分
        // “AIT 没给时间戳”与“我们的候选/裁剪逻辑把段全部丢掉”。
        console.error(`[rolling-asr] canonical segment rejection meeting=${Number(meetingId)} diagnostics=${JSON.stringify({
          fileResult: summarizeFileAsrResultShape(result),
          rows: rows.length,
          candidateRows: candidateRows.length,
          commitStartMs: effectiveWindowStartMs,
          commitEndMs: effectiveWindowEndMs,
          composition: replacement.compositionTrace || {},
        })}`);
        throw new Error("file transcription produced no canonical stable segments");
      }
      const alignmentMode = replacement.usedTextTimingFallback ? "file_text_timing_fallback" : "file_canonical";
      if (replacement.usedTextTimingFallback) {
        console.warn(`[rolling-asr] applied text-only file ASR with realtime timing meeting=${Number(meetingId)} diagnostics=${JSON.stringify({
          fileResult: summarizeFileAsrResultShape(result),
          candidateRows: candidateRows.length,
          insertedCount: replacement.insertedCount,
          commitStartMs: effectiveWindowStartMs,
          commitEndMs: effectiveWindowEndMs,
        })}`);
      }
      if (windowRunId) await this.store.finalizeWindowRun(windowRunId, alignmentMode, replacement.insertedCount, replacement.compositionTrace);
      await this.afterStableCorrection(meetingId, replacement.stableRevision);

      // 说话人分离是增强项，不得卡住文本稳定化、窗口提交或会议结束。
      // 每个成功的窗口只对刚插入的稳定行回填；失败则保留“待识别”，等待后续窗口/会后归集。
      void this.enrichStableWindowSpeakers({
        meetingId,
        wav,
        audioPath,
        fileResult: result,
        insertedRows: replacement.insertedRows,
        windowStartAudioMs,
        centerStartAudioMs: effectiveWindowStartMs,
        centerEndAudioMs: effectiveWindowEndMs,
      }).then((speakerResult) => {
        if (speakerResult?.ok === false) {
          console.warn(`[rolling-speaker] skipped meeting=${Number(meetingId)} reason=${String(speakerResult.reason || "unknown")}`);
        }
      }).catch((error) => {
        console.warn(`[rolling-speaker] skipped meeting=${Number(meetingId)}: ${error instanceof Error ? error.message : String(error)}`);
      });

      return {
        ok: true,
        updatedCount: 0,
        insertedCount: replacement.insertedCount,
        deletedCount: replacement.deletedCount,
        skippedCount: 0,
        lastProcessedTranscriptId: replacement.lastTranscriptId || Number(startTranscriptId || 0),
        model,
        submissionMode,
        sourceLength: correctedText.length,
        hotwordCount,
        hotwordChars: hotwordText.length,
        stableRevision: replacement.stableRevision,
        alignmentMode,
        windowStartAudioMs,
        windowEndAudioMs,
        commitEndAudioMs: effectiveWindowEndMs,
        forcedBoundary,
        replacedRealtimeRowCount: candidateRows.length,
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
    fallbackText = "",
    model = ROLLING_ASR_MODEL,
    hotwords = [],
    glossaryEntries = [],
    audioPath = "",
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
    const normalizedFallbackText = normalizeTranscriptSegment(fallbackText);
    // 只有全文 text 的成功响应使用实时 VAD 时间轴受控落轴；没有文本时仍然
    // 保持原有失败语义，绝不凭空把草稿标成稳定稿。
    if (!preview.length && !normalizedFallbackText) {
      return {
        insertedCount: 0,
        deletedCount: 0,
        lastTranscriptId: 0,
        compositionTrace: {
          version: 1,
          effectiveWindowStartMs: Math.round(Number(effectiveWindowStartMs || 0)),
          effectiveWindowEndMs: Math.round(Number(effectiveWindowEndMs || 0)),
          previewTiming: previewAuditTrace,
          preview: [],
          rejectedReason: "no_file_timestamps_or_text",
        },
      };
    }

    // 同一事务内替换窗口旧自动行并插入新的 canonical 段。
    // 不可先单独删除再插入：文件段的构成或数据库写入失败时，旧做法会让
    // 用户在会中看到一段草稿直接消失。
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
      fallbackText: normalizedFallbackText,
      model,
      hotwords,
      glossaryEntries,
      replaceExistingAutoRows: true,
      auditTrace: {},
      audioPath,
      abortSignal,
    });

    return {
      ...inserted,
      deletedCount: Number(inserted.deletedCount || 0),
      compositionTrace: {
        version: 1,
        effectiveWindowStartMs: Math.round(Number(effectiveWindowStartMs || 0)),
        effectiveWindowEndMs: Math.round(Number(effectiveWindowEndMs || 0)),
        previewTiming: previewAuditTrace,
        preview: preview.map(summarizeCompositionSegment),
        usedTextTimingFallback: Boolean(inserted.usedTextTimingFallback),
        deletedCount: Number(inserted.deletedCount || 0),
        replacementInTransaction: true,
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
    fallbackText = "",
    model = ROLLING_ASR_MODEL,
    hotwords = [],
    replaceExistingAutoRows = false,
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

    const timestampSegments = getAbsoluteFileSegments(
      fileResult,
      trimLeadingSeconds,
      windowStartAudioMs,
      previousStableText,
      trimTrailingSeconds,
      Math.max(0, Number(windowEndAudioMs || 0) - Number(windowStartAudioMs || 0)),
      { sourceSpeechIntervals, commitStartMs, commitEndMs, auditTrace },
    );
    const usedTextTimingFallback = !timestampSegments.length && Boolean(normalizeTranscriptSegment(fallbackText));
    const rawCandidateSegments = usedTextTimingFallback
      ? buildFileTextTimingFallbackSegments(fallbackText, speakerRows, { commitStartMs, commitEndMs })
      : timestampSegments;
    const candidateSegments = applySpeakerHintsToFileSegments(rawCandidateSegments, speakerRows).map((segment) => ({
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
        usedTextTimingFallback,
        compositionTrace: { commitStartMs, commitEndMs, timing: auditTrace, usedTextTimingFallback, candidates: [], canonical: [], inserted: [] },
      };
    }

    const segments = composeCanonicalFileSegments(candidateSegments, {
      windowStartMs: commitStartMs,
      windowEndMs: Math.max(commitStartMs + 1, commitEndMs),
      protectedRows: [],
      // 上一个中心区已经是稳定稿事实来源。只有明确的连续前后缀才裁剪，避免
      // 相邻窗口的重叠区把同一句再次插入；不是泛化 LCS，不会删除真实重复表达。
      precedingRows: previousStableText ? [{ text: previousStableText, audioEndMs: commitStartMs }] : [],
    });

    if (!segments.length) {
      return {
        insertedCount: 0,
        insertedIds: [],
        lastTranscriptId: 0,
        compositionTrace: {
          commitStartMs, commitEndMs, timing: auditTrace,
          usedTextTimingFallback,
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
          usedTextTimingFallback,
          candidates: candidateSegments.map(summarizeCompositionSegment),
          canonical: segments.map(summarizeCompositionSegment),
          inserted: [],
        },
      };
    }

    const { insertedCount, insertedIds, stableRevision, deletedCount } = await this.store.insertFileAsrStableSegments(meetingId, {
      segments: boundedSegments.map((segment) => ({
        time: formatMeetingElapsedTime(segment.startMs / 1000),
        speaker: segment.speaker || "待识别",
        text: segment.text,
        speakerSource: segment.speakerSource || "file_asr",
        startMs: segment.startMs,
        endMs: segment.endMs,
      })),
      protectedRows: [],
      precedingRows: previousStableText ? [{ text: previousStableText, audioEndMs: commitStartMs }] : [],
      model,
      audioPath,
      windowStartMs: commitStartMs,
      windowEndMs: commitEndMs,
      replaceExistingAutoRows,
    });

    return {
      insertedCount,
      insertedIds,
      stableRevision: Number(stableRevision || 0),
      deletedCount: Number(deletedCount || 0),
      usedTextTimingFallback,
      lastTranscriptId: insertedIds[insertedIds.length - 1] || 0,
      compositionTrace: {
        commitStartMs, commitEndMs, timing: auditTrace,
        usedTextTimingFallback,
        candidates: candidateSegments.map(summarizeCompositionSegment),
        canonical: segments.map(summarizeCompositionSegment),
        inserted: [],
      },
      insertedRows: boundedSegments.map((segment, index) => ({
        id: Number(insertedIds[index] || 0),
        speaker: segment.speaker || "待识别",
        speakerSource: segment.speakerSource || "file_asr",
        audioStartMs: Number(segment.startMs || 0),
        audioEndMs: Number(segment.endMs || 0),
        userEdited: 0,
      })).filter((row) => row.id > 0),
    };
  }

  /**
   * 对已落库的稳定窗口做轻量说话人回填。
   * 文件分离模型的 speaker_0/1 只在当前窗口有效，必须先经会议级声纹轨道管理器
   * 映射成全会身份；只有具备至少 200ms 时间重叠的行才更新，人工编辑永远由 store 保护。
   */
  async enrichStableWindowSpeakers({
    meetingId,
    wav,
    audioPath,
    fileResult,
    insertedRows,
    windowStartAudioMs,
    centerStartAudioMs,
    centerEndAudioMs,
  }) {
    if (!this.diarizeSpeakerSegments || !this.resolveDiarizedSpeakerTracks || !Array.isArray(insertedRows) || !insertedRows.length || !wav?.length) {
      return { ok: false, reason: "speaker_enrichment_unavailable" };
    }
    const diarizationSegments = await this.diarizeSpeakerSegments({
      meetingId,
      wav,
      audioPath,
      timeoutMs: 30_000,
    });
    if (!Array.isArray(diarizationSegments) || !diarizationSegments.length) {
      return { ok: false, reason: "diarization_empty" };
    }
    const trackAssignments = await this.resolveDiarizedSpeakerTracks({
      meetingId,
      wav,
      segments: diarizationSegments,
    });
    const globalByLocal = new Map((Array.isArray(trackAssignments) ? trackAssignments : [])
      .filter((item) => item?.status === "confirmed" && item?.speaker && item.speaker !== "待识别")
      .map((item) => [String(item.key), item]));
    if (!globalByLocal.size) return { ok: false, reason: "speaker_tracks_unconfirmed" };
    const resolvedSegments = diarizationSegments
      .map((segment) => {
        const resolved = globalByLocal.get(String(segment?.speaker || ""));
        return resolved ? {
          ...segment,
          speaker: resolved.speaker,
          confidence: Math.max(Number(segment.confidence || 0), Number(resolved.confidence || 0)),
        } : null;
      })
      .filter(Boolean);
    const absoluteSegments = buildAbsoluteSpeakerSegments(resolvedSegments, {
      windowStartMs: windowStartAudioMs,
      centerStartMs: centerStartAudioMs,
      centerEndMs: centerEndAudioMs,
    });
    if (!absoluteSegments.length) return { ok: false, reason: "diarization_outside_commit_window" };

    const speakerByWindowLabel = new Map();
    for (const segment of absoluteSegments) {
      const speaker = String(segment.speaker || "").trim();
      if (!speaker || speaker === "待识别") continue;
      const confidence = Number(segment.confidence || 70);
      const current = speakerByWindowLabel.get(speaker);
      if (!current || confidence > current.confidence) speakerByWindowLabel.set(speaker, { speaker, confidence });
    }
    const matches = assignSpeakersByAbsoluteOverlap(insertedRows, absoluteSegments, speakerByWindowLabel);
    const assignments = matches.map(({ row, winner }) => ({
      id: Number(row.id),
      speaker: winner.speaker,
      confidence: Number(winner.confidence || 70),
    })).filter((item) => item.id > 0 && item.speaker && item.speaker !== "待识别");

    // 文件稿一行可能横跨多次换人。仅按“整行最大重叠”归给一个人，会把行内
    // 其他人的发言全部算成同一个说话人。只有逐词时间戳能完整复原稳定文字时
    // 才按真实换人点拆行；任何漏词、热词改写或时间不完整都继续保守地整行归属。
    const timestampScale = getFileTimestampScale(fileResult || {});
    const timedWords = buildAbsoluteTimedWords(fileResult?.words || [], {
      windowStartMs: windowStartAudioMs,
      timestampScale,
    });
    const splitPlans = planSpeakerTurnSplits(
      insertedRows,
      timedWords,
      absoluteSegments,
      speakerByWindowLabel,
    ).map((plan) => ({
      ...plan,
      groups: plan.groups.map((group) => ({
        ...group,
        time: formatMeetingElapsedTime(Number(group.startMs || 0) / 1000),
      })),
    }));
    const splitRowIds = new Set(splitPlans.map((plan) => Number(plan?.row?.id || 0)));
    const wholeRowAssignments = assignments.filter((item) => !splitRowIds.has(Number(item.id)));
    if (!wholeRowAssignments.length && !splitPlans.length) return { ok: false, reason: "no_row_overlap" };

    const applied = await this.store.applySpeakerEnrichment(meetingId, {
      transcriptIds: insertedRows.map((row) => Number(row.id)).filter((id) => id > 0),
      assignments: wholeRowAssignments,
      splitPlans,
    });
    if (Number(applied?.updatedCount || 0) > 0) {
      await this.afterStableCorrection(meetingId, Number(applied.stableRevision || 0));
    }
    return {
      ok: true,
      speakerCount: new Set([
        ...wholeRowAssignments.map((item) => item.speaker),
        ...splitPlans.flatMap((plan) => plan.groups.map((group) => group.speaker)),
      ]).size,
      updatedCount: Number(applied?.updatedCount || 0),
      splitRowCount: Number(applied?.splitRowCount || 0),
      insertedRowCount: Number(applied?.insertedRowCount || 0),
      stableRevision: Number(applied?.stableRevision || 0),
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
