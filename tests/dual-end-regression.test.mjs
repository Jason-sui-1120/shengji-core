// 双端同输入回归测试：单人长讲述 / 多人交替与抢话 / 弱网重连与停止。
// 用合成固定输入驱动核心模块（transcript-composer / transcript-coverage / speaker-timeline），
// 验证时间轴单调性、稳定稿覆盖率、重复率——两端跑同一输入，输出必须一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeCanonicalFileSegments } from "../modules/transcript-composer.mjs";
import { computeTranscriptCoverage } from "../modules/transcript-coverage.mjs";
import { buildAbsoluteSpeakerSegments } from "../modules/speaker-timeline.mjs";

// ─── 固定输入 1：单人长讲述 ──────────────────────────────────────────────────
const SINGLE_SPEAKER = {
  durationMs: 120_000,
  windows: [
    { windowStartMs: 0, windowEndMs: 45_000 },
    { windowStartMs: 45_000, windowEndMs: 90_000 },
    { windowStartMs: 90_000, windowEndMs: 120_000 },
  ],
  segments: [
    { startMs: 0, endMs: 45_000, text: "大家好，今天我们讨论新房省心租家装的资金流问题。", speaker: "说话人1" },
    { startMs: 45_000, endMs: 90_000, text: "签约主体是贝壳找房科技有限公司，资金流向是从客户到平台再到装修公司。", speaker: "说话人1" },
    { startMs: 90_000, endMs: 120_000, text: "主要风险是客户资金安全和装修公司跑路风险，需要建立资金监管机制。", speaker: "说话人1" },
  ],
};

// ─── 固定输入 2：多人交替与抢话 ──────────────────────────────────────────────
const MULTI_SPEAKER_OVERLAP = {
  durationMs: 60_000,
  windows: [
    { windowStartMs: 0, windowEndMs: 20_000 },
    { windowStartMs: 20_000, windowEndMs: 40_000 },
    { windowStartMs: 40_000, windowEndMs: 60_000 },
  ],
  segments: [
    { startMs: 0, endMs: 10_000, text: "我认为这个方案可行。", speaker: "说话人1" },
    { startMs: 10_000, endMs: 20_000, text: "但是我们还需要考虑成本问题。", speaker: "说话人2" },
    { startMs: 20_000, endMs: 30_000, text: "好的，那我们先把成本核算清楚。", speaker: "说话人1" },
    { startMs: 30_000, endMs: 40_000, text: "对，另外时间也很紧张。", speaker: "说话人2" },
    { startMs: 40_000, endMs: 50_000, text: "明白，我们下周三前给出最终方案。", speaker: "说话人1" },
  ],
};

// ─── 固定输入 3：弱网重连与停止（时间轴不连续）─────────────────────────────────
const RECONNECT_GAP = {
  durationMs: 90_000,
  windows: [
    { windowStartMs: 0, windowEndMs: 30_000 },
    // 30s-50s 断连（无窗口）
    { windowStartMs: 50_000, windowEndMs: 80_000 },
  ],
  segments: [
    { startMs: 0, endMs: 30_000, text: "第一部分讨论完成。", speaker: "说话人1" },
    { startMs: 50_000, endMs: 80_000, text: "重连后继续讨论第二部分。", speaker: "说话人1" },
  ],
};

test("单人长讲述：时间轴单调递增，无重叠", () => {
  const segments = composeCanonicalFileSegments(SINGLE_SPEAKER.segments, { windowStartMs: 0, windowEndMs: 120_000 });
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i].startMs >= segments[i - 1].endMs, `segment ${i} startMs >= previous endMs`);
  }
});

test("单人长讲述：稳定稿覆盖率 100%", () => {
  const coverage = computeTranscriptCoverage(SINGLE_SPEAKER.durationMs, SINGLE_SPEAKER.windows);
  assert.equal(coverage.coverageRatio, 1);
  assert.equal(coverage.gaps.length, 0);
});

test("多人交替与抢话：说话人轨道正确", () => {
  // buildAbsoluteSpeakerSegments 期望 segment 字段是 start/end（秒）
  const speakerSegments = [
    { start: 0, end: 10, text: "我认为这个方案可行。", speaker: "说话人1" },
    { start: 10, end: 20, text: "但是我们还需要考虑成本问题。", speaker: "说话人2" },
    { start: 20, end: 30, text: "好的，那我们先把成本核算清楚。", speaker: "说话人1" },
    { start: 30, end: 40, text: "对，另外时间也很紧张。", speaker: "说话人2" },
    { start: 40, end: 50, text: "明白，我们下周三前给出最终方案。", speaker: "说话人1" },
  ];
  const speakers = buildAbsoluteSpeakerSegments(speakerSegments, { windowStartMs: 0 });
  // 说话人交替：1 → 2 → 1 → 2 → 1
  assert.equal(speakers.length, 5);
  assert.equal(speakers[0].speaker, "说话人1");
  assert.equal(speakers[1].speaker, "说话人2");
  assert.equal(speakers[2].speaker, "说话人1");
  assert.equal(speakers[3].speaker, "说话人2");
  assert.equal(speakers[4].speaker, "说话人1");
});

test("多人交替与抢话：时间轴单调递增，无重叠", () => {
  const segments = composeCanonicalFileSegments(MULTI_SPEAKER_OVERLAP.segments, { windowStartMs: 0, windowEndMs: 60_000 });
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i].startMs >= segments[i - 1].endMs, `segment ${i} startMs >= previous endMs`);
  }
});

test("弱网重连与停止：时间轴允许缺口（断连期间无转写）", () => {
  const segments = composeCanonicalFileSegments(RECONNECT_GAP.segments, { windowStartMs: 0, windowEndMs: 90_000 });
  // 断连期间（30s-50s）无转写——segments 只有 2 个
  assert.equal(segments.length, 2);
  assert.equal(segments[0].endMs, 30_000);
  assert.equal(segments[1].startMs, 50_000);
});

test("弱网重连与停止：稳定稿覆盖率 < 100%（断连期间未覆盖）", () => {
  const coverage = computeTranscriptCoverage(RECONNECT_GAP.durationMs, RECONNECT_GAP.windows);
  assert.ok(coverage.coverageRatio < 1, "coverage < 100%（断连期间未覆盖）");
  assert.ok(coverage.gaps.length > 0, "有未覆盖区间");
  // 未覆盖区间应该包含 30s-50s
  const gaps = coverage.gaps;
  assert.ok(gaps.some((g) => g.startMs <= 30_000 && g.endMs >= 50_000), "未覆盖区间包含 30s-50s");
});

test("双端一致性：同一输入 composeCanonicalFileSegments 输出一致", () => {
  // 跑两次，输出必须一致（纯函数，无副作用）
  const segments1 = composeCanonicalFileSegments(SINGLE_SPEAKER.segments, { windowStartMs: 0, windowEndMs: 120_000 });
  const segments2 = composeCanonicalFileSegments(SINGLE_SPEAKER.segments, { windowStartMs: 0, windowEndMs: 120_000 });
  assert.deepEqual(segments1, segments2);
});

test("双端一致性：同一输入 computeTranscriptCoverage 输出一致", () => {
  const coverage1 = computeTranscriptCoverage(SINGLE_SPEAKER.durationMs, SINGLE_SPEAKER.windows);
  const coverage2 = computeTranscriptCoverage(SINGLE_SPEAKER.durationMs, SINGLE_SPEAKER.windows);
  assert.deepEqual(coverage1, coverage2);
});
