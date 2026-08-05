/**
 * transcript-align.mjs —— 滚动转写对齐校正纯函数（两端共用）。
 * 文件 ASR 稿与实时草稿的对齐、时间轴归一、说话人投射、文本清理。
 * 全部为无 DB 依赖的纯函数。
 */
import { normalizeTranscriptSegment } from "./text-utils.mjs";
import { normalizeForTranscriptCompare } from "./evidence-utils.mjs";
import { getAbsoluteFileSegments, getCharOverlapRatio, getFileTimestampScale, normalizeFileTimestamp } from "./file-segments.mjs";
import { normalizeConfidence } from "./speaker-core.mjs";

export function isUsableTranscriptCorrection(original, corrected) {
  if (!corrected) return false;
  const originalCompact = original.replace(/\s/g, "");
  const correctedCompact = corrected.replace(/\s/g, "");
  if (!correctedCompact) return false;
  if (correctedCompact.length < Math.max(4, originalCompact.length * 0.45)) return false;
  if (correctedCompact.length > originalCompact.length * 1.8 + 8) return false;
  if (originalCompact.length >= 12 && getCharOverlapRatio(originalCompact, correctedCompact) < 0.55) return false;
  if (hasCriticalTokenDrift(original, corrected)) return false;
  return true;
}

export function extractStableWindowText(result, trimLeadingSeconds = 0, trimTrailingSeconds = 0, requestDurationSeconds = 0) {
  const trim = Math.max(0, Number(trimLeadingSeconds || 0));
  const trimTrailing = Math.max(0, Number(trimTrailingSeconds || 0));
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const timestampScale = getFileTimestampScale(result);
  if ((trim > 0 || trimTrailing > 0) && segments.length) {
    const requestEnd = Math.max(Number(requestDurationSeconds || 0), segments.reduce((max, segment) => Math.max(
      max,
      normalizeFileTimestamp(segment?.end ?? segment?.end_time ?? segment?.endTime ?? 0, timestampScale),
    ), 0));
    const centerEnd = Math.max(trim, requestEnd - trimTrailing);
    const afterOverlap = segments
      // 句子按“起点属于哪个中心 45 秒”唯一归属；一旦归属就保留整句，
      // 不因句尾越过 45 秒边界而截断。
      .filter((segment) => {
        const start = normalizeFileTimestamp(segment?.start ?? segment?.start_time ?? segment?.startTime ?? 0, timestampScale);
        return start >= trim && start < centerEnd;
      })
      .map((segment) => segment?.text || "")
      .join(" ");
    if (afterOverlap.trim()) return normalizeTranscriptSegment(afterOverlap);
  }
  return normalizeTranscriptSegment(
    result?.text || segments.map((segment) => segment?.text || "").join(" "),
  );
}

export async function alignRollingCorrectionToRows(rows, correctedText, fileResult, trimLeadingSeconds = 0, timing = {}) {
  const fileTimed = alignFileSegmentsToRowsByAbsoluteTime(
    rows,
    fileResult,
    trimLeadingSeconds,
    Number(timing.windowStartAudioMs || 0),
    String(timing.previousStableText || ""),
    Number(timing.trimTrailingSeconds || 0),
    Math.max(0, Number(timing.windowEndAudioMs || 0) - Number(timing.windowStartAudioMs || 0)),
    // 中心提交区间与语音轨道——缺失时对齐层只能按请求上下文对齐，
    // 会把前一窗口重叠内容错配到本窗实时行。
    {
      commitStartMs: timing.commitStartMs,
      commitEndMs: timing.commitEndMs,
      sourceSpeechIntervals: timing.sourceSpeechIntervals,
    },
  );
  if (fileTimed.length && fileTimed.some((line) => line.fileSegmentCount > 0)) {
    return {
      lines: fileTimed,
      mode: "file_timing",
      consistency: compareTranscriptVersions(rows, correctedText),
    };
  }
  if (rows.length === 1) {
    const row = rows[0];
    const rowDurationMs = Math.max(0, Number(row.audioEndMs || 0) - Number(row.audioStartMs || 0));
    const fileSegments = Array.isArray(fileResult?.segments) ? fileResult.segments : [];
    const timestampScale = getFileTimestampScale(fileResult);
    const fileEndMs = fileSegments.reduce((max, segment) => Math.max(max, normalizeFileTimestamp(segment?.end ?? segment?.end_time ?? segment?.endTime ?? 0, timestampScale) * 1000), 0);
    // 单行只有在其时间跨度足以覆盖文件窗口时才能承接整段文件稿；否则保留
    // 实时稿，避免校准把几十秒内容覆盖到一条极短行。
    if (rowDurationMs > 0 && fileEndMs > 0 && rowDurationMs < fileEndMs * 0.35) {
      return { lines: [{ id: row.id, text: row.text }], mode: "timing_guard", consistency: "needs_review" };
    }
    return { lines: [{ id: row.id, text: correctedText }], mode: "single", consistency: compareTranscriptVersions(rows, correctedText) };
  }
  // 文件模型没有返回可用片段时间时，按实时行的时间/时长确定性分配全文。
  // LLM 不再参与普通稳定稿的行分配，避免改写、删字或改变时间归属。
  return {
    lines: alignFileTextByTiming(rows, correctedText, fileResult, trimLeadingSeconds),
    mode: "timing_fallback",
    consistency: compareTranscriptVersions(rows, correctedText),
  };
}

export function alignFileSegmentsToRowsByAbsoluteTime(rows, fileResult, trimLeadingSeconds = 0, windowStartAudioMs = 0, previousStableText = "", trimTrailingSeconds = 0, requestDurationMs = 0, timeline = {}) {
  if (!rows.length) return [];
  const timedSegments = getAbsoluteFileSegments(fileResult, trimLeadingSeconds, windowStartAudioMs, previousStableText, trimTrailingSeconds, requestDurationMs, timeline);
  if (!timedSegments.length) return [];

  // P0-3: 按源片段 ID（startMs + text 前缀）去重——相邻窗口重叠区间的同一片段只分配一次
  const seenSegmentKeys = new Set();
  const uniqueSegments = [];
  for (const segment of timedSegments) {
    const key = `${Math.round(segment.startMs)}:${(segment.text || "").slice(0, 20)}`;
    if (seenSegmentKeys.has(key)) continue;
    seenSegmentKeys.add(key);
    uniqueSegments.push(segment);
  }

  const assigned = rows.map(() => []);
  for (const segment of uniqueSegments) {
    let bestIndex = -1;
    let bestOverlap = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const midpoint = (segment.startMs + segment.endMs) / 2;
    rows.forEach((row, index) => {
      const rowStart = Number(row.audioStartMs || 0);
      const rowEnd = Math.max(rowStart + 1, Number(row.audioEndMs || rowStart + 1));
      const overlap = Math.max(0, Math.min(rowEnd, segment.endMs) - Math.max(rowStart, segment.startMs));
      const distance = Math.abs(midpoint - (rowStart + rowEnd) / 2);
      if (overlap > bestOverlap || (overlap === bestOverlap && distance < nearestDistance)) {
        bestIndex = index;
        bestOverlap = overlap;
        nearestDistance = distance;
      }
    });
    // 零重叠片段不得分配给"距离最近"的行——那会把前一窗口尾部内容拼进
    // 本窗实时行（银标重复主因）。窗口间有 8 秒重叠，边界片段会由相邻
    // 窗口的中心区间正确承接，跳过不丢内容。
    if (bestIndex < 0 || bestOverlap <= 0) continue;
    assigned[bestIndex].push(segment);
  }

  return rows.map((row, index) => {
    const matches = assigned[index].sort((a, b) => a.startMs - b.startMs);
    if (!matches.length) {
      return {
        id: row.id,
        text: row.text,
        audioStartMs: Number(row.audioStartMs || 0),
        audioEndMs: Number(row.audioEndMs || 0),
        fileSegmentCount: 0,
      };
    }
    return {
      id: row.id,
      text: normalizeTranscriptSegment(matches.map((segment) => segment.text).join(" ")) || row.text,
      // 文件 ASR 的片段时间戳在部分模型中是“有效语音时间”，静音会被
      // 压缩，不能拿来覆盖实时/VAD 已落定的绝对会议时间。文件结果只负责
      // 改文字，行的起止仍以源录音时间轴上的原始范围为准。
      audioStartMs: Number(row.audioStartMs || 0),
      audioEndMs: Number(row.audioEndMs || 0),
      fileSegmentCount: matches.length,
    };
  });
}

export function longestCommonSubsequenceLength(a, b) {
  let previous = new Uint16Array(b.length + 1);
  for (const char of a) {
    const current = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) current[j] = char === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    previous = current;
  }
  return previous[b.length];
}

export function alignFileTextByTiming(rows, correctedText, fileResult, trimLeadingSeconds = 0) {
  const segments = Array.isArray(fileResult?.segments) ? fileResult.segments : [];
  const timestampScale = getFileTimestampScale(fileResult);
  const units = getTimedFileUnits(fileResult, trimLeadingSeconds);
  const weights = rows.map((row) => Math.max(1, Number(row.audioDurationMs || 0)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const boundaries = [];
  let cursor = 0;
  for (const weight of weights) { cursor += weight / total; boundaries.push(cursor); }
  const assigned = rows.map(() => []);

  // 优先用 segment 级文本（完整句子）分配，避免 word 级碎片化
  const segmentUnits = segments.length
    ? segments.map((seg) => {
        const text = String(seg?.text ?? "").trim();
        const start = normalizeFileTimestamp(seg?.start ?? seg?.start_time ?? seg?.startTime ?? 0, timestampScale);
        const end = normalizeFileTimestamp(seg?.end ?? seg?.end_time ?? seg?.endTime ?? start, timestampScale);
        const midpoint = (start + end) / 2 - trimLeadingSeconds;
        return { text, start: Math.max(0, start - trimLeadingSeconds), end: Math.max(0, end - trimLeadingSeconds), midpoint: Math.max(0, midpoint) };
      }).filter((item) => item.text && item.end >= 0)
    : units;

  if (segmentUnits.length) {
    const lastEnd = segmentUnits[segmentUnits.length - 1].end || 1;
    for (const unit of segmentUnits) {
      const position = Math.min(0.999, Math.max(0, unit.midpoint / Math.max(0.001, lastEnd)));
      const index = boundaries.findIndex((boundary) => position < boundary);
      assigned[index < 0 ? rows.length - 1 : index].push(unit.text);
    }
  } else {
    // 没有 segment 和 word 时间戳时，按文本长度权重切割
    const pieces = splitTextByWeights(correctedText, weights);
    pieces.forEach((text, index) => assigned[index].push(text));
  }
  return rows.map((row, index) => ({ id: row.id, text: normalizeTranscriptSegment(assigned[index].join(" ")) || row.text }));
}

export function mapDiarizationSpeakersToRows(rows, aligned, diarizationSegments, durationSeconds, trimLeadingSeconds = 0) {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(diarizationSegments) || !diarizationSegments.length) return new Map();
  const textById = new Map((aligned || []).map((item) => [Number(item.id), normalizeTranscriptSegment(item.text)]));
  const weights = rows.map((row) => Math.max(1, (textById.get(Number(row.id)) || row.text || "").replace(/\s/g, "").length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const startOffset = Math.max(0, Number(trimLeadingSeconds || 0));
  const usableDuration = Math.max(0, Number(durationSeconds || 0) - startOffset);
  if (!usableDuration) return new Map();

  // 构建 diarization speaker label → 现有 speaker_profiles label 的映射
  // 通过统计每个 diarization label 在各行中的"获胜次数"来匹配最可能的现有 label
  const diarizationLabels = [...new Set(diarizationSegments.map((seg) => seg.speaker).filter(Boolean))];
  const labelVoteCount = new Map(); // diarizationLabel → Map(existingLabel → count)
  for (const dLabel of diarizationLabels) labelVoteCount.set(dLabel, new Map());

  const result = new Map();
  let cursor = startOffset;
  for (let index = 0; index < rows.length; index += 1) {
    const rowDuration = usableDuration * weights[index] / totalWeight;
    const end = cursor + rowDuration;
    let winner = null;
    let maxOverlap = 0;
    for (const segment of diarizationSegments) {
      const overlap = Math.max(0, Math.min(end, Number(segment.end || 0)) - Math.max(cursor, Number(segment.start || 0)));
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        winner = segment;
      }
    }
    if (winner && maxOverlap >= Math.min(0.35, rowDuration * 0.2)) {
      // 记录投票：这个 diarization label 在这一行获胜，投给行已有的 speaker
      const existingLabel = String(rows[index].speaker || "").trim();
      if (existingLabel && existingLabel !== "待识别") {
        const votes = labelVoteCount.get(winner.speaker);
        votes.set(existingLabel, (votes.get(existingLabel) || 0) + 1);
      }
      result.set(Number(rows[index].id), {
        speaker: winner.speaker,
        confidence: normalizeConfidence(winner.confidence),
      });
    }
    cursor = end;
  }

  // 将 diarization label 映射到现有 speaker_profiles label
  // 投票最多的现有 label 成为该 diarization label 的映射目标
  const labelMapping = new Map();
  for (const [dLabel, votes] of labelVoteCount) {
    let bestLabel = null;
    let bestCount = 0;
    for (const [existingLabel, count] of votes) {
      if (count > bestCount) { bestCount = count; bestLabel = existingLabel; }
    }
    if (bestLabel) labelMapping.set(dLabel, bestLabel);
  }

  // 应用映射：把 diarization label 替换为映射后的现有 label
  if (labelMapping.size) {
    for (const [rowId, speakerInfo] of result) {
      const mapped = labelMapping.get(speakerInfo.speaker);
      if (mapped) result.set(rowId, { ...speakerInfo, speaker: mapped });
    }
  }

  return result;
}

export function removeFillerWords(text) {
  let result = String(text || "");
  // 移除句首的 filler 词："嗯。好。我们需要..." → "我们需要..."
  result = result.replace(/^(嗯+[。！？!?,，.]?\s*)+/g, "");
  result = result.replace(/^(啊+[。！？!?,，.]?\s*)+/g, "");
  result = result.replace(/^(呃+[。！？!?,，.]?\s*)+/g, "");
  result = result.replace(/^(哦+[。！？!?,，.]?\s*)+/g, "");
  result = result.replace(/^(哎+[。！？!?,，.]?\s*)+/g, "");
  result = result.replace(/^(唉+[。！？!?,，.]?\s*)+/g, "");
  // 移除句中的独立 filler 片段："我们需要 嗯。 推进" → "我们需要推进"
  result = result.replace(/\s*(嗯+|啊+|呃+|哦+|哎+|唉+|哈+|嘛+|呢+|吧+|呀+|额+|噢+|唔+|哼+|嗷+|呜+|嘿+|呵+)[。！？!?,，.]\s*/g, "");
  // 移除连续的 filler 句子："嗯。嗯。嗯。我们需要" → "我们需要"
  result = result.replace(/^(嗯+[。！？!?,，.]\s*)+/g, "");
  result = result.replace(/^(啊+[。！？!?,，.]\s*)+/g, "");
  // 清理多余空格和标点
  result = result.replace(/\s+/g, " ").replace(/^[。！？!?,，.;：:、\s]+/, "").trim();
  return result;
}

export function mergeTranscriptText(buffer, segment) {
  if (!buffer) return segment;
  if (!segment) return buffer;
  if (buffer.endsWith(segment)) return buffer;
  if (segment.startsWith(buffer)) return segment;

  const maxOverlap = Math.min(buffer.length, segment.length, 16);
  for (let size = maxOverlap; size >= 3; size -= 1) {
    if (buffer.slice(-size) === segment.slice(0, size)) {
      return buffer + segment.slice(size);
    }
  }

  const needsSpace = /[a-zA-Z0-9]$/.test(buffer) && /^[a-zA-Z0-9]/.test(segment);
  return `${buffer}${needsSpace ? " " : ""}${segment}`;
}

export function hasCriticalTokenDrift(original, corrected) {
  const originalTokens = extractCriticalTokens(original);
  if (!originalTokens.length) return false;
  const correctedCompact = String(corrected || "").replace(/\s/g, "");
  let lost = 0;
  for (const token of originalTokens) {
    if (!correctedCompact.includes(token)) lost += 1;
  }
  return lost >= Math.max(2, Math.ceil(originalTokens.length * 0.55));
}

export function extractCriticalTokens(value) {
  const text = String(value || "");
  const tokens = new Set();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}|[0-9０-９]+(?:[.点][0-9０-９]+)?|[一二三四五六七八九十]+月|周[一二三四五六日天]|下周[一二三四五六日天]?|今天|明天|后天/g)) {
    tokens.add(match[0].replace(/\s/g, ""));
  }
  return Array.from(tokens);
}

export function compareTranscriptVersions(rows, correctedText) {
  const live = normalizeForTranscriptCompare(rows.map((row) => row.text).join(""));
  const file = normalizeForTranscriptCompare(correctedText);
  if (!live || !file) return "needs_review";
  const overlap = longestCommonSubsequenceLength(live, file) / Math.max(live.length, file.length);
  return overlap >= 0.58 ? "normal" : "needs_review";
}

export function getTimedFileUnits(result, trimLeadingSeconds = 0) {
  const raw = Array.isArray(result?.words) && result.words.length ? result.words : (Array.isArray(result?.segments) ? result.segments : []);
  const timestampScale = getFileTimestampScale(result);
  return raw.map((item) => {
    const text = String(item?.text ?? item?.word ?? item?.token ?? "").trim();
    const start = normalizeFileTimestamp(item?.start ?? item?.start_time ?? item?.startTime ?? 0, timestampScale);
    const end = normalizeFileTimestamp(item?.end ?? item?.end_time ?? item?.endTime ?? start, timestampScale);
    return { text, start: Math.max(0, start - trimLeadingSeconds), end: Math.max(0, end - trimLeadingSeconds), midpoint: Math.max(0, ((start + end) / 2) - trimLeadingSeconds) };
  }).filter((item) => item.text && item.end >= 0);
}

export function splitTextByWeights(text, weights) {
  const source = normalizeTranscriptSegment(text);
  const total = weights.reduce((sum, value) => sum + value, 0) || weights.length;
  let offset = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return source.slice(offset);
    const next = Math.min(source.length, offset + Math.max(1, Math.round(source.length * weight / total)));
    const piece = source.slice(offset, next);
    offset = next;
    return piece;
  });
}

