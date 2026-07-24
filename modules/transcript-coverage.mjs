function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function computeTranscriptCoverage(
  durationMs,
  windows,
  { gapToleranceMs = 750 } = {},
) {
  const duration = Math.max(0, Math.round(finiteNumber(durationMs)));
  if (!duration) return { durationMs: 0, coveredMs: 0, coverageRatio: 1, gaps: [], intervals: [] };
  const intervals = (Array.isArray(windows) ? windows : [])
    .map((window) => {
      const startMs = Math.max(0, Math.round(
        finiteNumber(window?.windowStartMs ?? window?.startMs)
          + Math.max(0, finiteNumber(window?.trimLeadingMs)),
      ));
      const endMs = Math.min(duration, Math.round(
        finiteNumber(window?.windowEndMs ?? window?.endMs)
          - Math.max(0, finiteNumber(window?.trimTrailingMs)),
      ));
      return { startMs, endMs };
    })
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.startMs <= previous.endMs + Math.max(0, finiteNumber(gapToleranceMs))) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }
  const gaps = [];
  let cursor = 0;
  for (const interval of merged) {
    if (interval.startMs > cursor + Math.max(0, finiteNumber(gapToleranceMs))) {
      gaps.push({ startMs: cursor, endMs: interval.startMs, durationMs: interval.startMs - cursor });
    }
    cursor = Math.max(cursor, interval.endMs);
  }
  if (cursor < duration - Math.max(0, finiteNumber(gapToleranceMs))) {
    gaps.push({ startMs: cursor, endMs: duration, durationMs: duration - cursor });
  }
  const uncoveredMs = gaps.reduce((sum, gap) => sum + gap.durationMs, 0);
  return {
    durationMs: duration,
    coveredMs: Math.max(0, duration - uncoveredMs),
    coverageRatio: Number(((duration - uncoveredMs) / duration).toFixed(6)),
    gaps,
    intervals: merged,
  };
}

export function planCoverageRepairWindows(
  gaps,
  durationMs,
  {
    centerWindowMs = 45_000,
    contextMs = 8_000,
    limit = 12,
  } = {},
) {
  const duration = Math.max(0, Math.round(finiteNumber(durationMs)));
  const centerSize = Math.max(1_000, Math.round(finiteNumber(centerWindowMs, 45_000)));
  const context = Math.max(0, Math.round(finiteNumber(contextMs, 8_000)));
  const plans = [];
  for (const gap of Array.isArray(gaps) ? gaps : []) {
    let centerStartMs = Math.max(0, Math.round(finiteNumber(gap?.startMs)));
    const gapEndMs = Math.min(duration, Math.max(centerStartMs, Math.round(finiteNumber(gap?.endMs))));
    while (centerStartMs < gapEndMs && plans.length < Math.max(1, Math.round(finiteNumber(limit, 12)))) {
      const centerEndMs = Math.min(gapEndMs, centerStartMs + centerSize);
      const windowStartMs = Math.max(0, centerStartMs - context);
      const windowEndMs = Math.min(duration, centerEndMs + context);
      plans.push({
        centerStartMs,
        centerEndMs,
        windowStartMs,
        windowEndMs,
        trimLeadingMs: centerStartMs - windowStartMs,
        trimTrailingMs: windowEndMs - centerEndMs,
      });
      centerStartMs = centerEndMs;
    }
    if (plans.length >= Math.max(1, Math.round(finiteNumber(limit, 12)))) break;
  }
  return plans;
}
