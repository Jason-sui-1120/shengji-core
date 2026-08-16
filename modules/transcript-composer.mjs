function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function comparableText(value) {
  return normalizeText(value).replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]]/g, "").toLowerCase();
}

function comparableTextWithSourceIndexes(value) {
  const source = String(value || "");
  const characters = [];
  const sourceIndexes = [];
  for (let index = 0; index < source.length; index += 1) {
    const comparable = comparableText(source[index]);
    for (const character of comparable) {
      characters.push(character);
      sourceIndexes.push(index);
    }
  }
  return { text: characters.join(""), sourceIndexes };
}

function sourceIndexAfterComparableOffset(value, comparableOffset) {
  const projection = comparableTextWithSourceIndexes(value);
  if (!projection.text || comparableOffset <= 0) return 0;
  if (comparableOffset >= projection.sourceIndexes.length) return String(value || "").length;
  return projection.sourceIndexes[comparableOffset];
}

// 只接受“上一稳定稿的结尾 = 新窗口开头”的连续重叠，不能用泛化 LCS
// 删除字符：会议中同一句话被重复说出并不少见，泛化匹配会误删真实内容。
function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    for (let index = 0; index <= right.length; index += 1) previous[index] = current[index];
  }
  return previous[right.length];
}

function findBoundaryPrefixOverlap(
  previousText,
  candidateText,
  {
    minimumChars = 6,
    fuzzyMinimumChars = 12,
    fuzzySimilarity = 0.78,
  } = {},
) {
  const previous = comparableText(previousText);
  const candidate = comparableText(candidateText);
  const limit = Math.min(previous.length, candidate.length, 240);
  for (let size = limit; size >= minimumChars; size -= 1) {
    if (previous.slice(-size) === candidate.slice(0, size)) return size;
  }
  // 同一段音频经过相邻两次文件 ASR 后，少量同音字、漏字和口头词通常不一致。
  // 这里仍只比较“上一段连续后缀”和“下一段连续前缀”，并要求较长且高度相似；
  // 不做全文 LCS，避免把会议中真实复述误删。
  let bestFuzzy = null;
  const fuzzySuffixLimit = Math.min(previous.length, 240);
  for (let suffixSize = fuzzySuffixLimit; suffixSize >= fuzzyMinimumChars; suffixSize -= 1) {
    const suffix = previous.slice(-suffixSize);
    const sizeDelta = Math.min(12, Math.max(2, Math.round(suffixSize * 0.15)));
    const minimumPrefixSize = Math.max(fuzzyMinimumChars, suffixSize - sizeDelta);
    const maximumPrefixSize = Math.min(candidate.length, suffixSize + sizeDelta);
    for (let prefixSize = maximumPrefixSize; prefixSize >= minimumPrefixSize; prefixSize -= 1) {
      const prefix = candidate.slice(0, prefixSize);
      const similarity = 1 - editDistance(suffix, prefix) / Math.max(suffixSize, prefixSize);
      if (similarity >= fuzzySimilarity && (
        !bestFuzzy
        || similarity > bestFuzzy.similarity
        || (similarity === bestFuzzy.similarity && prefixSize > bestFuzzy.prefixSize)
      )) {
        bestFuzzy = { similarity, prefixSize };
      }
    }
  }
  return bestFuzzy?.prefixSize || 0;
}

function trimCandidateAgainstBoundary(candidate, boundaryText, boundaryEndMs, { maxGapMs = 10_000 } = {}) {
  const gap = Number(candidate.startMs || 0) - Number(boundaryEndMs || 0);
  if (gap < -1_000 || gap > maxGapMs) return candidate;
  const overlap = findBoundaryPrefixOverlap(boundaryText, candidate.text);
  if (!overlap) return candidate;
  const comparable = comparableText(candidate.text);
  if (overlap >= comparable.length) return null;
  const sourceOffset = sourceIndexAfterComparableOffset(candidate.text, overlap);
  const text = normalizeText(String(candidate.text || "").slice(sourceOffset));
  if (!text) return null;
  // 没有逐词时间时，只能按已删除文本比例向后推进句子起点；此处不改变
  // 结束时间，避免随后单调钳制把重复文本推到错误的未来时间。
  const ratio = overlap / Math.max(1, comparable.length);
  const startMs = Math.min(
    Number(candidate.endMs || 0) - 1,
    Math.max(Number(candidate.startMs || 0), Math.round(Number(candidate.startMs || 0) + (Number(candidate.endMs || 0) - Number(candidate.startMs || 0)) * ratio)),
  );
  return { ...candidate, text, startMs };
}

function textsAreDuplicate(left, right) {
  const a = comparableText(left);
  const b = comparableText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  return shorter.length >= 8 && longer.includes(shorter) && shorter.length / longer.length >= 0.72;
}

function overlapMs(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

export function composeCanonicalFileSegments(
  inputSegments,
  {
    windowStartMs = 0,
    windowEndMs = Number.MAX_SAFE_INTEGER,
    protectedRows = [],
    precedingRows = [],
  } = {},
) {
  const lowerBound = Math.max(0, finiteNumber(windowStartMs));
  const upperBound = Math.max(lowerBound + 1, finiteNumber(windowEndMs, Number.MAX_SAFE_INTEGER));
  const protectedIntervals = (Array.isArray(protectedRows) ? protectedRows : [])
    .filter((row) => row?.userEdited || row?.speakerSource === "manual")
    .map((row) => ({
      startMs: Math.max(0, finiteNumber(row?.audioStartMs)),
      endMs: Math.max(1, finiteNumber(row?.audioEndMs)),
    }))
    .filter((row) => row.endMs > row.startMs);

  const candidates = (Array.isArray(inputSegments) ? inputSegments : [])
    .map((segment, sourceIndex) => ({
      ...segment,
      sourceIndex,
      text: normalizeText(segment?.text),
      startMs: Math.max(lowerBound, finiteNumber(segment?.startMs)),
      endMs: Math.min(upperBound, finiteNumber(segment?.endMs)),
    }))
    .filter((segment) => segment.text && segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.sourceIndex - b.sourceIndex);

  // 先消除与已提交稳定稿边界的重叠，再做本窗口内的单调化。顺序不能反：
  // 若先单调化，重复句会被推到未来，既留下重复也破坏回放定位。
  const boundary = (Array.isArray(precedingRows) ? precedingRows : [])
    .filter((row) => !row?.userEdited && row?.speakerSource !== "manual")
    .map((row) => ({
      text: normalizeText(row?.text),
      endMs: finiteNumber(row?.audioEndMs),
    }))
    .filter((row) => row.text && row.endMs > 0)
    .sort((a, b) => a.endMs - b.endMs)
    .at(-1);

  const output = [];
  for (const candidate of candidates) {
    const conflictsWithManual = protectedIntervals.some((interval) => (
      overlapMs(candidate.startMs, candidate.endMs, interval.startMs, interval.endMs) > 0
    ));
    if (conflictsWithManual) continue;

    const previous = output.at(-1);
    // 前一个窗口的重复内容前面可能先返回一个很短的语气词，因此不能只检查
    // 本窗口第一条。只在边界后 1.5 秒内持续对照上一稳定稿，范围外不再去重。
    if (boundary) {
      const trimmed = trimCandidateAgainstBoundary(candidate, boundary.text, boundary.endMs, { maxGapMs: 1_500 });
      if (!trimmed) continue;
      Object.assign(candidate, trimmed);
    }
    if (previous) {
      const overlap = overlapMs(previous.startMs, previous.endMs, candidate.startMs, candidate.endMs);
      if (overlap > 0 && textsAreDuplicate(previous.text, candidate.text)) continue;
      // 同一窗口里，文件模型也可能在相邻句之间回吐前一句尾巴。仅在时间
      // 重叠或紧邻时按连续前后缀裁掉，避免把真实重复表达误判为重复。
      const trimmed = trimCandidateAgainstBoundary(candidate, previous.text, previous.endMs, { maxGapMs: 1_000 });
      if (!trimmed) continue;
      Object.assign(candidate, trimmed);
      if (candidate.startMs < previous.endMs) candidate.startMs = previous.endMs;
    }
    if (candidate.endMs <= candidate.startMs) continue;
    output.push(candidate);
  }
  return output.map(({ sourceIndex, ...segment }) => segment);
}

export function buildAbsoluteTimedWords(
  words,
  {
    windowStartMs = 0,
    timestampScale = 1,
  } = {},
) {
  const requestStartMs = Math.max(0, finiteNumber(windowStartMs));
  const scale = Math.max(1, finiteNumber(timestampScale, 1));
  return (Array.isArray(words) ? words : [])
    .map((word, sourceIndex) => {
      const text = normalizeText(word?.text ?? word?.word ?? word?.token);
      const relativeStartMs = Math.round(finiteNumber(word?.start ?? word?.start_time ?? word?.startTime) * 1000 / scale);
      const relativeEndMs = Math.round(finiteNumber(word?.end ?? word?.end_time ?? word?.endTime) * 1000 / scale);
      return {
        text,
        sourceIndex,
        startMs: requestStartMs + Math.max(0, relativeStartMs),
        endMs: requestStartMs + Math.max(relativeStartMs + 1, relativeEndMs),
      };
    })
    .filter((word) => word.text && word.endMs > word.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.sourceIndex - b.sourceIndex)
    .map(({ sourceIndex, ...word }) => word);
}

function identifiedSpeakerForWord(word, speakerSegments, speakerByWindowLabel) {
  let winner = null;
  let winnerOverlapMs = 0;
  for (const segment of Array.isArray(speakerSegments) ? speakerSegments : []) {
    const identified = speakerByWindowLabel.get(segment?.speaker);
    if (!identified?.speaker || identified.speaker === "待识别") continue;
    const overlap = overlapMs(
      word.startMs,
      word.endMs,
      finiteNumber(segment?.absoluteStartMs),
      finiteNumber(segment?.absoluteEndMs),
    );
    if (overlap > winnerOverlapMs) {
      winner = identified;
      winnerOverlapMs = overlap;
    }
  }
  return winnerOverlapMs > 0 ? winner : null;
}

export function planSpeakerTurnSplits(
  rows,
  timedWords,
  speakerSegments,
  speakerByWindowLabel,
) {
  const mapping = speakerByWindowLabel instanceof Map
    ? speakerByWindowLabel
    : new Map(Object.entries(speakerByWindowLabel || {}));
  const plans = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.userEdited || row?.speakerSource === "manual") continue;
    const rowStartMs = Math.max(0, finiteNumber(row?.audioStartMs));
    const rowEndMs = Math.max(rowStartMs + 1, finiteNumber(row?.audioEndMs, rowStartMs + 1));
    const words = (Array.isArray(timedWords) ? timedWords : []).filter((word) => (
      overlapMs(rowStartMs, rowEndMs, finiteNumber(word?.startMs), finiteNumber(word?.endMs)) > 0
    ));
    if (words.length < 2) continue;

    // 拆行必须能证明逐词结果完整覆盖原稳定文字。只要热词修正、漏词或
    // 标点以外的内容存在差异，就放弃拆行，避免按字数猜测词与说话人。
    const sourceProjection = comparableTextWithSourceIndexes(row?.text);
    const comparableWords = words.map((word) => comparableText(word.text));
    if (comparableWords.some((text) => !text)) continue;
    if (comparableWords.join("") !== sourceProjection.text) continue;

    const groups = [];
    let compactOffset = 0;
    let unsafe = false;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const identified = identifiedSpeakerForWord(word, speakerSegments, mapping);
      if (!identified) {
        unsafe = true;
        break;
      }
      const compactLength = comparableWords[index].length;
      const previous = groups.at(-1);
      if (previous?.speaker === identified.speaker) {
        previous.endMs = Math.max(previous.endMs, word.endMs);
        previous.compactEnd = compactOffset + compactLength;
        previous.confidence = Math.min(previous.confidence, finiteNumber(identified.confidence));
      } else {
        groups.push({
          speaker: identified.speaker,
          confidence: finiteNumber(identified.confidence),
          startMs: Math.max(rowStartMs, word.startMs),
          endMs: Math.min(rowEndMs, word.endMs),
          compactStart: compactOffset,
          compactEnd: compactOffset + compactLength,
        });
      }
      compactOffset += compactLength;
    }
    if (unsafe || groups.length < 2) continue;

    const splitGroups = groups.map((group, index) => {
      const sourceStart = group.compactStart === 0
        ? 0
        : sourceProjection.sourceIndexes[group.compactStart];
      const sourceEnd = group.compactEnd >= sourceProjection.sourceIndexes.length
        ? String(row.text || "").length
        : sourceProjection.sourceIndexes[group.compactEnd];
      const startMs = index === 0 ? rowStartMs : Math.max(rowStartMs, group.startMs);
      const endMs = index === groups.length - 1 ? rowEndMs : Math.min(rowEndMs, group.endMs);
      return {
        speaker: group.speaker,
        confidence: group.confidence,
        text: String(row.text || "").slice(sourceStart, sourceEnd).trim(),
        startMs,
        endMs: Math.max(startMs + 1, endMs),
      };
    });
    if (splitGroups.some((group) => !group.text || group.endMs <= group.startMs)) continue;
    plans.push({ row, groups: splitGroups });
  }
  return plans;
}
