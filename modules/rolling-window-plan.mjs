/**
 * 滚动文件 ASR 的窗口规划。
 *
 * 核心约束：commit 区间属于源录音时间轴，不能由文件 ASR 返回的时间戳决定。
 * 前后上下文只用于让识别模型看完整句；每个 commit 区间只会被提交一次。
 */

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

export function normalizeSpeechIntervals(intervals = []) {
  return intervals
    .map((item) => ({
      startMs: Math.max(0, Math.round(number(item?.startMs))),
      endMs: item?.endMs == null ? null : Math.max(0, Math.round(number(item.endMs))),
    }))
    .filter((item) => item.endMs == null || item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs)
    .reduce((merged, item) => {
      const previous = merged.at(-1);
      if (previous && previous.endMs != null && item.startMs <= previous.endMs + 120) {
        previous.endMs = item.endMs == null ? null : Math.max(previous.endMs, item.endMs);
      } else {
        merged.push({ ...item });
      }
      return merged;
    }, []);
}

/** 从提交边界向前找一个语音起点，作为下一窗左上下文。 */
export function findRollingContextStart({
  commitStartMs,
  speechIntervals = [],
  baseLookbackMs = 8_000,
  maxLookbackMs = 20_000,
}) {
  const commitStart = Math.max(0, Math.round(number(commitStartMs)));
  const lower = Math.max(0, commitStart - Math.max(baseLookbackMs, maxLookbackMs));
  const preferred = Math.max(lower, commitStart - Math.max(0, baseLookbackMs));
  const intervals = normalizeSpeechIntervals(speechIntervals);
  // 优先取覆盖 preferred 的句子起点；否则取 preferred 之前最近的语音终点后的安全位置。
  const crossing = intervals.find((item) => item.startMs <= preferred && (item.endMs == null || item.endMs >= preferred));
  if (crossing) return Math.max(lower, crossing.startMs);
  const before = intervals.filter((item) => item.startMs >= lower && item.startMs <= preferred).at(-1);
  return before ? before.startMs : preferred;
}

/**
 * 用源音频 VAD 规划一个窗口。非最终窗口必须等到右侧上下文足够；若连续说话
 * 超过最大向前搜索范围，强制在 hardLimit 处分界并标记 continuation。
 */
export function buildRollingWindowPlan({
  requestStartMs,
  availableEndMs,
  commitStartMs,
  isFinal = false,
  windowMs = 45_000,
  baseLookbackMs = 8_000,
  maxLookbackMs = 20_000,
  rightContextMs = 8_000,
  maxForwardExtensionMs = 30_000,
  speechIntervals = [],
}) {
  const requestStart = Math.max(0, Math.round(number(requestStartMs)));
  const availableEnd = Math.max(requestStart, Math.round(number(availableEndMs)));
  const commitStart = Math.max(requestStart, Math.round(number(commitStartMs, requestStart)));
  const targetEnd = commitStart + Math.max(500, Math.round(number(windowMs, 45_000)));
  const hardEnd = targetEnd + Math.max(0, Math.round(number(maxForwardExtensionMs, 30_000)));
  const intervals = normalizeSpeechIntervals(speechIntervals);
  const speechCrossesTarget = intervals.find((item) => item.startMs < targetEnd && (item.endMs == null || item.endMs > targetEnd));
  const completedAfterTarget = intervals.find((item) => item.endMs != null && item.endMs >= targetEnd && item.endMs <= hardEnd);

  let commitEndMs;
  let forcedBoundary = false;
  let continuation = false;
  if (isFinal && targetEnd >= availableEnd) {
    // 尾窗不足一个归属窗口时，只提交已收到的源音频；不能把未来不存在的
    // 45 秒目标当成边界，也不能把整个 backlog 误当作右侧上下文。
    commitEndMs = availableEnd;
  } else if (!speechCrossesTarget) {
    // 目标点已处于静音/换人间隙；无需为了下一句额外推迟提交。
    commitEndMs = targetEnd;
  } else if (completedAfterTarget) {
    commitEndMs = completedAfterTarget.endMs;
  } else if (isFinal) {
    // 尾窗无需等右侧上下文，但仍只提交真实已有的源录音。
    commitEndMs = Math.min(availableEnd, hardEnd);
  } else if (availableEnd >= hardEnd + rightContextMs) {
    commitEndMs = hardEnd;
    forcedBoundary = true;
    continuation = true;
  } else {
    return null;
  }

  if (commitEndMs <= commitStart + 250) return null;
  // 即使会议已经停止，尾窗也仍然逐段提交。右侧上下文最多取已有的 8 秒，
  // 禁止将加速回放中积压的全部后续音频一次性塞进一个文件 ASR 请求。
  const wantedRequestEnd = commitEndMs + Math.max(0, rightContextMs);
  if (!isFinal && availableEnd < wantedRequestEnd) return null;
  const requestEndMs = Math.min(availableEnd, wantedRequestEnd);
  if (requestEndMs <= commitEndMs && !isFinal) return null;

  return {
    requestStartMs: requestStart,
    requestEndMs,
    commitStartMs: commitStart,
    commitEndMs,
    trimLeadingSeconds: Math.max(0, commitStart - requestStart) / 1000,
    trimTrailingSeconds: Math.max(0, requestEndMs - commitEndMs) / 1000,
    forcedBoundary,
    continuation,
  };
}

/**
 * 有些文件 ASR 把静音压缩为“有效语音时钟”。将其映射回源录音 VAD 轨道。
 * 若没有可靠 VAD，调用方应保留原始时间，不应猜测。
 */
export function mapSpeechClockToSourceMs(relativeMs, sourceIntervals = []) {
  const clock = Math.max(0, number(relativeMs));
  const intervals = normalizeSpeechIntervals(sourceIntervals).filter((item) => item.endMs != null);
  let consumed = 0;
  for (const interval of intervals) {
    const duration = interval.endMs - interval.startMs;
    if (clock <= consumed + duration) return Math.round(interval.startMs + (clock - consumed));
    consumed += duration;
  }
  const tail = intervals.at(-1);
  return tail ? tail.endMs : null;
}

/**
 * 仅在模型明确返回“有效语音时钟”时才允许回映射。
 *
 * 不能只看模型结束时间略小于源音频时长：普通墙上时钟也会因为尾部静音或
 * VAD 边界提前结束。模型和有效语音长度必须彼此接近，且两者都明显短于
 * 本次请求，才认为静音确实被压缩。
 */
export function shouldMapSpeechClock({ requestDurationMs, sourceSpeechDurationMs, modelEndMs }) {
  const requestDuration = Math.max(0, number(requestDurationMs));
  const speechDuration = Math.max(0, number(sourceSpeechDurationMs));
  const modelEnd = Math.max(0, number(modelEndMs));
  if (requestDuration < 1_000 || speechDuration < 1_000 || modelEnd < 1_000) return false;
  const bothCompressed = speechDuration < requestDuration * 0.9
    && modelEnd < requestDuration * 0.9;
  const allowedDifference = Math.max(900, speechDuration * 0.06);
  return bothCompressed && Math.abs(modelEnd - speechDuration) <= allowedDifference;
}
