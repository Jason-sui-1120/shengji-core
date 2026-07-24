import test from "node:test";
import assert from "node:assert/strict";
import { buildRollingWindowPlan, findRollingContextStart, mapSpeechClockToSourceMs } from "./rolling-window-plan.mjs";

test("提交区间固定从 45 秒目标向后找句尾，前后上下文不改变归属", () => {
  const plan = buildRollingWindowPlan({
    requestStartMs: 0, availableEndMs: 63_000, commitStartMs: 0,
    speechIntervals: [{ startMs: 41_000, endMs: 52_000 }],
  });
  assert.equal(plan.commitStartMs, 0);
  assert.equal(plan.commitEndMs, 52_000);
  assert.equal(plan.requestEndMs, 60_000);
  assert.equal(plan.trimTrailingSeconds, 8);
});

test("连续发言超过向前上限时强制切分而不无限等待", () => {
  const plan = buildRollingWindowPlan({
    requestStartMs: 0, availableEndMs: 84_000, commitStartMs: 0,
    speechIntervals: [{ startMs: 40_000, endMs: null }],
  });
  assert.equal(plan.commitEndMs, 75_000);
  assert.equal(plan.forcedBoundary, true);
  assert.equal(plan.continuation, true);
});

test("目标点落在静音时直接提交，不等待下一句", () => {
  const plan = buildRollingWindowPlan({
    requestStartMs: 0, availableEndMs: 60_000, commitStartMs: 0,
    speechIntervals: [{ startMs: 36_000, endMs: 42_000 }, { startMs: 55_000, endMs: 58_000 }],
  });
  assert.equal(plan.commitEndMs, 45_000);
  assert.equal(plan.requestEndMs, 53_000);
});

test("停止时仍逐窗提交，不能把积压尾音频全部作为上下文", () => {
  const plan = buildRollingWindowPlan({
    requestStartMs: 221_000, availableEndMs: 600_000, commitStartMs: 221_000,
    isFinal: true, speechIntervals: [{ startMs: 230_000, endMs: 266_000 }],
  });
  assert.equal(plan.commitEndMs, 266_000);
  assert.equal(plan.requestEndMs, 274_000);
});

test("下一窗向前最多 20 秒寻找上下文句首", () => {
  assert.equal(findRollingContextStart({ commitStartMs: 97_000, speechIntervals: [{ startMs: 84_000, endMs: 99_000 }] }), 84_000);
  assert.equal(findRollingContextStart({ commitStartMs: 97_000, speechIntervals: [{ startMs: 70_000, endMs: 99_000 }] }), 77_000);
});

test("有效语音时钟可回映射到源录音 VAD 时间", () => {
  const intervals = [{ startMs: 0, endMs: 10_000 }, { startMs: 15_000, endMs: 25_000 }];
  assert.equal(mapSpeechClockToSourceMs(12_000, intervals), 17_000);
});
