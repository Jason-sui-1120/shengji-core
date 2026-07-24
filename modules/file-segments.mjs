/**
 * file-segments.mjs —— 文件 ASR 段处理纯函数（两端共用）。
 * 绝对时间轴段合成、重叠检测、格式化。
 */
import { normalizeTranscriptSegment } from "./text-utils.mjs";
import { normalizeSpeechIntervals, shouldMapSpeechClock, mapSpeechClockToSourceMs } from "./rolling-window-plan.mjs";
import { normalizeForTranscriptCompare } from "./evidence-utils.mjs";

export function getAbsoluteFileSegments(fileResult, trimLeadingSeconds = 0, windowStartAudioMs = 0, previousStableText = "", trimTrailingSeconds = 0, requestDurationMs = 0, timeline = {}) {
  const segments = Array.isArray(fileResult?.segments) ? fileResult.segments : [];
  if (!segments.length) return [];
  const timestampScale = getFileTimestampScale(fileResult);
  const trimMs = Math.max(0, Number(trimLeadingSeconds || 0) * 1000);
  const trimTrailingMs = Math.max(0, Number(trimTrailingSeconds || 0) * 1000);
  const requestEndMs = Math.max(Number(requestDurationMs || 0), segments.reduce((max, segment) => Math.max(
    max,
    Math.round(normalizeFileTimestamp(segment?.end ?? segment?.end_time ?? segment?.endTime ?? 0, timestampScale) * 1000),
  ), 0));
  const centerEndMs = Math.max(trimMs, requestEndMs - trimTrailingMs);
  const commitStartRelativeMs = Math.max(trimMs, Number(timeline?.commitStartMs ?? Number(windowStartAudioMs || 0)) - Number(windowStartAudioMs || 0));
  const commitEndRelativeMs = Math.max(commitStartRelativeMs + 1, Number(timeline?.commitEndMs ?? (Number(windowStartAudioMs || 0) + centerEndMs)) - Number(windowStartAudioMs || 0));
  const sourceWindowDurationMs = Math.max(0, Number(requestDurationMs || 0));
  const sourceSpeechIntervals = normalizeSpeechIntervals(timeline?.sourceSpeechIntervals || [])
    .filter((interval) => interval.endMs != null && interval.endMs > Number(windowStartAudioMs || 0))
    .map((interval) => ({
      startMs: Math.max(0, interval.startMs - Number(windowStartAudioMs || 0)),
      // plan 保存的是整场会议的 VAD 轨道；这里只能使用本次文件请求中
      // 实际存在的部分。此前没裁右边界会把后续窗口的语音也计进本窗，
      // 导致“有效语音时钟”判定失真。
      endMs: Math.min(
        sourceWindowDurationMs || Number.POSITIVE_INFINITY,
        Math.max(0, interval.endMs - Number(windowStartAudioMs || 0)),
      ),
    }))
    .filter((interval) => interval.endMs > interval.startMs);
  const speechDurationMs = sourceSpeechIntervals.reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0);
  const modelEndMs = segments.reduce((max, segment) => Math.max(max, Math.round(
    normalizeFileTimestamp(segment?.end ?? segment?.end_time ?? segment?.endTime ?? 0, timestampScale) * 1000,
  )), 0);
  const useSpeechClock = shouldMapSpeechClock({
    requestDurationMs,
    sourceSpeechDurationMs: speechDurationMs,
    modelEndMs,
  });
  const absoluteWords = (Array.isArray(fileResult?.words) ? fileResult.words : [])
    .map((word) => {
      const text = normalizeTranscriptSegment(word?.text ?? word?.word ?? word?.token ?? "");
      const relativeStartMs = Math.round(normalizeFileTimestamp(
        word?.start ?? word?.start_time ?? word?.startTime ?? 0,
        timestampScale,
      ) * 1000);
      const relativeEndMs = Math.round(normalizeFileTimestamp(
        word?.end ?? word?.end_time ?? word?.endTime ?? 0,
        timestampScale,
      ) * 1000);
      const mappedStartMs = useSpeechClock ? mapSpeechClockToSourceMs(relativeStartMs, sourceSpeechIntervals) : relativeStartMs;
      const mappedEndMs = useSpeechClock ? mapSpeechClockToSourceMs(relativeEndMs, sourceSpeechIntervals) : relativeEndMs;
      return {
        text,
        startMs: Number(windowStartAudioMs || 0) + Math.max(0, mappedStartMs ?? relativeStartMs),
        endMs: Number(windowStartAudioMs || 0) + Math.max(
          (mappedStartMs ?? relativeStartMs) + 1,
          mappedEndMs ?? relativeEndMs,
        ),
      };
    })
    .filter((word) => word.text && word.endMs > word.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const absoluteCommitStartMs = Number(windowStartAudioMs || 0) + commitStartRelativeMs;
  const absoluteCommitEndMs = Number(windowStartAudioMs || 0) + commitEndRelativeMs;
  // 追踪文件模型的原始时间和最终落轴时间。rolling 窗口的质量问题不能
  // 仅从文字猜测，必须能复盘每个窗口是否错误地启用了“有效语音时钟”。
  if (timeline?.auditTrace && typeof timeline.auditTrace === "object") {
    Object.assign(timeline.auditTrace, {
      timestampMode: useSpeechClock ? "speech_clock" : "wall_clock",
      requestDurationMs: Math.round(Number(requestDurationMs || 0)),
      sourceSpeechDurationMs: Math.round(speechDurationMs),
      modelEndMs: Math.round(modelEndMs),
      sourceSpeechIntervalCount: sourceSpeechIntervals.length,
      commitStartMs: Math.round(absoluteCommitStartMs),
      commitEndMs: Math.round(absoluteCommitEndMs),
    });
  }
  let timedSegments = segments.map((segment) => {
    const text = normalizeTranscriptSegment(segment?.text || "");
    const relativeStartMs = Math.round(normalizeFileTimestamp(segment?.start ?? segment?.start_time ?? segment?.startTime ?? 0, timestampScale) * 1000);
    const relativeEndMs = Math.round(normalizeFileTimestamp(segment?.end ?? segment?.end_time ?? segment?.endTime ?? 0, timestampScale) * 1000);
    const mappedStartMs = useSpeechClock ? mapSpeechClockToSourceMs(relativeStartMs, sourceSpeechIntervals) : relativeStartMs;
    const mappedEndMs = useSpeechClock ? mapSpeechClockToSourceMs(relativeEndMs, sourceSpeechIntervals) : relativeEndMs;
    // 原始映射时间必须保留到“归属窗口”判定完成。此前先把 startMs
    // 钳制到 trimMs，再用被钳制后的时间过滤：所有前置 overlap 片段都会
    // 伪装成从中心区开始，进而把同一句话重复写入稳定稿。
    const rawStartMs = Number(windowStartAudioMs || 0) + Math.max(0, mappedStartMs ?? relativeStartMs);
    const rawEndMs = Number(windowStartAudioMs || 0) + Math.max(
      (mappedStartMs ?? relativeStartMs) + 1,
      mappedEndMs ?? relativeEndMs,
    );
    return {
      text,
      startMs: rawStartMs,
      endMs: rawEndMs,
      rawStartMs,
      rawEndMs,
      relativeStartMs,
      relativeEndMs,
      mappedStartMs: Math.round(mappedStartMs ?? relativeStartMs),
      mappedEndMs: Math.round(mappedEndMs ?? relativeEndMs),
      timestampMode: useSpeechClock ? "speech_clock" : "wall_clock",
    };
  }).flatMap((segment) => {
    const crossesCommitBoundary = segment.rawStartMs < absoluteCommitStartMs
      || segment.rawEndMs > absoluteCommitEndMs;
    if (!crossesCommitBoundary || !absoluteWords.length) return [segment];

    // 文件模型返回逐词时间时，跨中心边界的长句必须按词切开。整句按起点
    // 丢弃会漏掉后半句；整句钳制则会把前半句带入下一窗并重复。
    const segmentWords = absoluteWords.filter((word) => (
      word.endMs > segment.rawStartMs && word.startMs < segment.rawEndMs
    ));
    const segmentProjection = normalizeForTranscriptCompare(segment.text);
    const wordsProjection = normalizeForTranscriptCompare(segmentWords.map((word) => word.text).join(""));
    if (!segmentWords.length || !segmentProjection || segmentProjection !== wordsProjection) return [segment];

    const ownedWords = segmentWords.filter((word) => {
      const midpointMs = (word.startMs + word.endMs) / 2;
      return midpointMs >= absoluteCommitStartMs && midpointMs < absoluteCommitEndMs;
    });
    if (!ownedWords.length) return [];
    return [{
      ...segment,
      text: normalizeTranscriptSegment(ownedWords.map((word) => word.text).join("")),
      rawStartMs: ownedWords[0].startMs,
      rawEndMs: ownedWords.at(-1).endMs,
      startMs: ownedWords[0].startMs,
      endMs: ownedWords.at(-1).endMs,
      wordBoundarySliced: true,
    }];
  }).filter((segment) => {
    // 一个没有逐词时间的长句，归属于其“真实起点”所在的中心区；绝不通过
    // 钳制时间让它跨窗口重复。逐词时间拆句由后续 speaker enrichment 使用。
    const rawRelativeStartMs = segment.rawStartMs - Number(windowStartAudioMs || 0);
    return segment.text && rawRelativeStartMs >= commitStartRelativeMs && rawRelativeStartMs < commitEndRelativeMs;
  }).map((segment) => ({
    ...segment,
    startMs: Math.max(
      absoluteCommitStartMs,
      segment.rawStartMs,
    ),
    endMs: Math.min(
      absoluteCommitEndMs,
      segment.rawEndMs,
    ),
  })).filter((segment) => segment.endMs > segment.startMs);
  if (!timedSegments.length) return [];
  // 禁止使用 LCS 之类的泛化相似度删除边界文本。会议里相同词、口头重复
  // 很常见，LCS 会把不连续的匹配字符当成重叠并静默删掉新内容。真正的
  // 连续前后缀重叠由 composeCanonicalFileSegments 负责处理。
  return timedSegments;
}



export function getCharOverlapRatio(a, b) {
  const aChars = new Set([...a]);
  const bChars = new Set([...b]);
  let overlap = 0;
  for (const char of aChars) {
    if (bChars.has(char)) overlap += 1;
  }
  const shorter = Math.min(aChars.size, bChars.size);
  return shorter ? overlap / shorter : 0;
}



export function summarizeCompositionSegment(segment) {
  return {
    startMs: Math.round(Number(segment?.startMs || 0)),
    endMs: Math.round(Number(segment?.endMs || 0)),
    rawStartMs: Math.round(Number(segment?.rawStartMs ?? segment?.startMs ?? 0)),
    rawEndMs: Math.round(Number(segment?.rawEndMs ?? segment?.endMs ?? 0)),
    relativeStartMs: Math.round(Number(segment?.relativeStartMs ?? 0)),
    relativeEndMs: Math.round(Number(segment?.relativeEndMs ?? 0)),
    mappedStartMs: Math.round(Number(segment?.mappedStartMs ?? 0)),
    mappedEndMs: Math.round(Number(segment?.mappedEndMs ?? 0)),
    timestampMode: String(segment?.timestampMode || "unknown"),
    wordBoundarySliced: Boolean(segment?.wordBoundarySliced),
    text: String(segment?.text || ""),
  };
}



export function formatMeetingElapsedTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}




export function getFileTimestampScale(result) {
  const items = [
    ...(Array.isArray(result?.segments) ? result.segments : []),
    ...(Array.isArray(result?.words) ? result.words : []),
  ];
  const maximum = items.reduce((max, item) => Math.max(
    max,
    Number(item?.start ?? item?.start_time ?? item?.startTime ?? 0) || 0,
    Number(item?.end ?? item?.end_time ?? item?.endTime ?? 0) || 0,
  ), 0);
  // rolling 窗口最长几十秒；最大时间超过 300 时可确定为毫秒。
  return maximum > 300 ? 1000 : 1;
}

export function normalizeFileTimestamp(value, scale = 1) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number / Math.max(1, Number(scale || 1));
}
