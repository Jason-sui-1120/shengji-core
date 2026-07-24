function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function buildAbsoluteSpeakerSegments(
  segments,
  {
    windowStartMs = 0,
    centerStartMs = windowStartMs,
    centerEndMs = Number.MAX_SAFE_INTEGER,
  } = {},
) {
  const requestStart = Math.max(0, finiteNumber(windowStartMs));
  const centerStart = Math.max(requestStart, finiteNumber(centerStartMs, requestStart));
  const centerEnd = Math.max(centerStart + 1, finiteNumber(centerEndMs, Number.MAX_SAFE_INTEGER));
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const relativeStartMs = Math.max(0, Math.round(finiteNumber(segment?.start) * 1000));
      const relativeEndMs = Math.max(relativeStartMs + 1, Math.round(finiteNumber(segment?.end) * 1000));
      return {
        ...segment,
        absoluteStartMs: requestStart + relativeStartMs,
        absoluteEndMs: requestStart + relativeEndMs,
      };
    })
    .filter((segment) => (
      segment.speaker
      && segment.absoluteEndMs > centerStart
      && segment.absoluteStartMs < centerEnd
    ))
    .sort((a, b) => a.absoluteStartMs - b.absoluteStartMs || a.absoluteEndMs - b.absoluteEndMs);
}

export function assignSpeakersByAbsoluteOverlap(
  rows,
  speakerSegments,
  speakerByWindowLabel,
  { minOverlapMs = 200 } = {},
) {
  const mapping = speakerByWindowLabel instanceof Map
    ? speakerByWindowLabel
    : new Map(Object.entries(speakerByWindowLabel || {}));
  const assignments = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.userEdited || row?.speakerSource === "manual") continue;
    const rowStartMs = Math.max(0, finiteNumber(row?.audioStartMs));
    const rowEndMs = Math.max(rowStartMs + 1, finiteNumber(row?.audioEndMs, rowStartMs + 1));
    let winner = null;
    let winnerOverlapMs = 0;
    for (const segment of Array.isArray(speakerSegments) ? speakerSegments : []) {
      const identified = mapping.get(segment?.speaker);
      if (!identified?.speaker || identified.speaker === "待识别") continue;
      const overlapMs = Math.max(
        0,
        Math.min(rowEndMs, finiteNumber(segment?.absoluteEndMs))
          - Math.max(rowStartMs, finiteNumber(segment?.absoluteStartMs)),
      );
      if (overlapMs > winnerOverlapMs) {
        winner = identified;
        winnerOverlapMs = overlapMs;
      }
    }
    if (!winner || winnerOverlapMs < Math.max(1, finiteNumber(minOverlapMs, 200))) continue;
    if (row.speaker === winner.speaker && row.speakerSource === "rolling_diarization") continue;
    assignments.push({ row, winner, overlapMs: winnerOverlapMs });
  }
  return assignments;
}
