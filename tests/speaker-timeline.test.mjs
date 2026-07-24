import test from "node:test";
import assert from "node:assert/strict";
import {
  assignSpeakersByAbsoluteOverlap,
  buildAbsoluteSpeakerSegments,
} from "./speaker-timeline.mjs";

test("窗口相对时间按请求起点换算为会议绝对时间", () => {
  const result = buildAbsoluteSpeakerSegments([
    { speaker: "speaker_1", start: 8.5, end: 12.25 },
  ], {
    windowStartMs: 45_000,
    centerStartMs: 53_000,
    centerEndMs: 90_000,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].absoluteStartMs, 53_500);
  assert.equal(result[0].absoluteEndMs, 57_250);
});

test("前后上下文外的说话人片段不进入中心窗口", () => {
  const result = buildAbsoluteSpeakerSegments([
    { speaker: "speaker_1", start: 0, end: 7.9 },
    { speaker: "speaker_2", start: 8, end: 10 },
    { speaker: "speaker_3", start: 53, end: 55 },
  ], {
    windowStartMs: 45_000,
    centerStartMs: 53_000,
    centerEndMs: 98_000,
  });
  assert.deepEqual(result.map((item) => item.speaker), ["speaker_2"]);
});

test("稳定行选择绝对时间重叠最大的会议级说话人", () => {
  const rows = [{ id: 1, audioStartMs: 10_000, audioEndMs: 14_000, speaker: "待识别", speakerSource: "file_asr" }];
  const segments = [
    { speaker: "speaker_1", absoluteStartMs: 9_000, absoluteEndMs: 11_000 },
    { speaker: "speaker_2", absoluteStartMs: 11_000, absoluteEndMs: 14_000 },
  ];
  const mapping = new Map([
    ["speaker_1", { speaker: "说话人 1", confidence: 70 }],
    ["speaker_2", { speaker: "说话人 2", confidence: 82 }],
  ]);
  const assignments = assignSpeakersByAbsoluteOverlap(rows, segments, mapping);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].winner.speaker, "说话人 2");
  assert.equal(assignments[0].overlapMs, 3_000);
});

test("人工编辑和人工说话人不会被自动回填覆盖", () => {
  const rows = [
    { id: 1, audioStartMs: 0, audioEndMs: 2_000, userEdited: 1, speakerSource: "file_asr" },
    { id: 2, audioStartMs: 2_000, audioEndMs: 4_000, userEdited: 0, speakerSource: "manual" },
  ];
  const segments = [{ speaker: "speaker_1", absoluteStartMs: 0, absoluteEndMs: 4_000 }];
  const mapping = new Map([["speaker_1", { speaker: "说话人 1", confidence: 70 }]]);
  assert.deepEqual(assignSpeakersByAbsoluteOverlap(rows, segments, mapping), []);
});

test("未映射到会议级声纹的窗口标签保持待识别", () => {
  const rows = [{ id: 1, audioStartMs: 0, audioEndMs: 2_000, speakerSource: "file_asr" }];
  const segments = [{ speaker: "speaker_9", absoluteStartMs: 0, absoluteEndMs: 2_000 }];
  assert.deepEqual(assignSpeakersByAbsoluteOverlap(rows, segments, new Map()), []);
});
