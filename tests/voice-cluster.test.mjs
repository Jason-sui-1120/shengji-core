import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

// 同一测试会复制到消费端 server/；兼容 core 源目录与端侧目录。
const voiceClusterModuleUrl = existsSync(new URL("../modules/voice-cluster.mjs", import.meta.url))
  ? new URL("../modules/voice-cluster.mjs", import.meta.url)
  : new URL("./voice-cluster.mjs", import.meta.url);
const {
  normalizeVector,
  cosineSimilarity,
  buildVoiceWindows,
  clusterVoiceEmbeddings,
  assignTranscriptSpeakers,
  MERGE_MORE_PARAMS,
} = await import(voiceClusterModuleUrl);

test("normalizeVector 归一化为单位向量", () => {
  const v = normalizeVector([3, 4]);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
});

test("cosineSimilarity 相同向量为 1，正交为 0", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test("buildVoiceWindows 按停顿和时长切块", () => {
  const words = [
    { startSeconds: 0, endSeconds: 1, text: "你" },
    { startSeconds: 1, endSeconds: 2, text: "好" },
    // 大停顿 1.0s > maxGapSeconds 0.65 → 切开
    { startSeconds: 3, endSeconds: 4, text: "我" },
    { startSeconds: 4, endSeconds: 4.5, text: "是" },
  ];
  const windows = buildVoiceWindows(words, { minSeconds: 1.0 });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].text, "你好");
  assert.equal(windows[1].text, "我是");
});

test("buildVoiceWindows 过短块被丢弃", () => {
  const words = [{ startSeconds: 0, endSeconds: 0.5, text: "嗯" }];
  const windows = buildVoiceWindows(words, { minSeconds: 1.2 });
  assert.equal(windows.length, 0);
});

test("clusterVoiceEmbeddings 相似声纹归为一簇", () => {
  // 两个方向明显不同的"说话人"
  const spkA = normalizeVector([1, 0, 0]);
  const spkB = normalizeVector([0, 1, 0]);
  const samples = [
    { startSeconds: 0, endSeconds: 3, vector: [...spkA] },
    { startSeconds: 5, endSeconds: 8, vector: normalizeVector([0.98, 0.02, 0]) }, // A 的轻微扰动
    { startSeconds: 10, endSeconds: 13, vector: [...spkB] },
    { startSeconds: 15, endSeconds: 18, vector: normalizeVector([0.02, 0.98, 0]) }, // B 的轻微扰动
  ];
  const result = clusterVoiceEmbeddings(samples, { assignThreshold: 0.6, mergeThreshold: 0.7, minMargin: 0.05 });
  const accepted = result.assignments.filter((a) => a.accepted);
  assert.equal(accepted.length, 4);
  // 前两个应同簇，后两个应同簇，且两簇不同
  assert.equal(accepted[0].clusterId, accepted[1].clusterId);
  assert.equal(accepted[2].clusterId, accepted[3].clusterId);
  assert.notEqual(accepted[0].clusterId, accepted[2].clusterId);
});

test("clusterVoiceEmbeddings 默认用 merge_more 参数", () => {
  const samples = [{ startSeconds: 0, endSeconds: 3, vector: normalizeVector([1, 0]) }];
  // 不传 options，应不抛错且用默认
  const result = clusterVoiceEmbeddings(samples);
  assert.equal(result.assignments.length, 1);
  assert.equal(MERGE_MORE_PARAMS.mergeThreshold, 0.71);
});

test("assignTranscriptSpeakers 重叠加权回填", () => {
  const transcripts = [{ audioStartMs: 0, audioEndMs: 4000, text: "你好" }];
  const assignments = [{ startSeconds: 0, endSeconds: 4, clusterId: "cluster_1", accepted: true }];
  const result = assignTranscriptSpeakers(transcripts, assignments);
  assert.equal(result[0].proposedSpeaker, "cluster_1");
  assert.ok(result[0].proposedConfidence > 0);
});

test("assignTranscriptSpeakers 无覆盖时保持待识别", () => {
  const transcripts = [{ audioStartMs: 10000, audioEndMs: 14000, text: "无覆盖" }];
  const assignments = [{ startSeconds: 0, endSeconds: 4, clusterId: "cluster_1", accepted: true }];
  const result = assignTranscriptSpeakers(transcripts, assignments);
  assert.equal(result[0].proposedSpeaker, "待识别");
});

test("assignTranscriptSpeakers 不因 250ms 局部碰触覆盖整行", () => {
  const transcripts = [{ audioStartMs: 0, audioEndMs: 10_000, text: "长行只被局部碰到" }];
  const assignments = [{ startSeconds: 0, endSeconds: 3, clusterId: "说话人 1", accepted: true }];
  const [result] = assignTranscriptSpeakers(transcripts, assignments);
  assert.equal(result.proposedSpeaker, "待识别");
  assert.equal(result.diagnostics.coverage, 0.3);
});

test("assignTranscriptSpeakers 覆盖充分且主导明确时才回填整行", () => {
  const transcripts = [{ audioStartMs: 0, audioEndMs: 10_000, text: "主要由第二个人发言" }];
  const assignments = [
    { startSeconds: 0, endSeconds: 2.5, clusterId: "说话人 1", accepted: true },
    { startSeconds: 2.5, endSeconds: 10, clusterId: "说话人 2", accepted: true },
  ];
  const [result] = assignTranscriptSpeakers(transcripts, assignments);
  assert.equal(result.proposedSpeaker, "说话人 2");
  assert.equal(result.diagnostics.coverage, 1);
  assert.equal(result.diagnostics.dominance, 0.75);
});

test("assignTranscriptSpeakers 两人均分一行时保持待识别", () => {
  const transcripts = [{ audioStartMs: 0, audioEndMs: 10_000, text: "两人各说一半" }];
  const assignments = [
    { startSeconds: 0, endSeconds: 5, clusterId: "说话人 1", accepted: true },
    { startSeconds: 5, endSeconds: 10, clusterId: "说话人 2", accepted: true },
  ];
  const [result] = assignTranscriptSpeakers(transcripts, assignments);
  assert.equal(result.proposedSpeaker, "待识别");
  assert.equal(result.diagnostics.dominance, 0.5);
});
