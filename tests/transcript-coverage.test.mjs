import test from "node:test";
import assert from "node:assert/strict";
import { computeTranscriptCoverage, planCoverageRepairWindows } from "./transcript-coverage.mjs";

test("文件窗口按前后裁剪后的中心区间计算覆盖", () => {
  const audit = computeTranscriptCoverage(90_000, [
    { windowStartMs: 0, windowEndMs: 53_000, trimTrailingMs: 8_000 },
    { windowStartMs: 37_000, windowEndMs: 90_000, trimLeadingMs: 8_000 },
  ]);
  assert.equal(audit.coverageRatio, 1);
  assert.deepEqual(audit.gaps, []);
});

test("中间缺失窗口会返回精确绝对时间缺口", () => {
  const audit = computeTranscriptCoverage(120_000, [
    { startMs: 0, endMs: 45_000 },
    { startMs: 90_000, endMs: 120_000 },
  ]);
  assert.deepEqual(audit.gaps, [{ startMs: 45_000, endMs: 90_000, durationMs: 45_000 }]);
  assert.equal(audit.coverageRatio, 0.625);
});

test("亚秒级窗口边界误差不被误报为音频缺失", () => {
  const audit = computeTranscriptCoverage(90_000, [
    { startMs: 0, endMs: 44_700 },
    { startMs: 45_200, endMs: 90_000 },
  ], { gapToleranceMs: 750 });
  assert.deepEqual(audit.gaps, []);
});

test("长缺口拆成45秒中心窗并自动附加前后8秒上下文", () => {
  const plans = planCoverageRepairWindows([
    { startMs: 45_000, endMs: 140_000 },
  ], 180_000);
  assert.equal(plans.length, 3);
  assert.deepEqual(plans[0], {
    centerStartMs: 45_000,
    centerEndMs: 90_000,
    windowStartMs: 37_000,
    windowEndMs: 98_000,
    trimLeadingMs: 8_000,
    trimTrailingMs: 8_000,
  });
  assert.equal(plans[2].centerEndMs, 140_000);
});
