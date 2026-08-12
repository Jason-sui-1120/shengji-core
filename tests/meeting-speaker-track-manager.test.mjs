import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

// 同一测试会复制到消费端 server/；兼容 core 源目录与端侧目录。
const managerModuleUrl = existsSync(new URL("../modules/meeting-speaker-track-manager.mjs", import.meta.url))
  ? new URL("../modules/meeting-speaker-track-manager.mjs", import.meta.url)
  : new URL("./meeting-speaker-track-manager.mjs", import.meta.url);
const { createMeetingSpeakerTrackManager } = await import(managerModuleUrl);

function vector(index) {
  const result = [0, 0, 0, 0];
  result[index] = 1;
  return result;
}

function createMemoryStore(seed = []) {
  let nextId = seed.length + 1;
  const rows = seed.map((row, index) => ({ id: index + 1, sampleCount: 1, ...row }));
  return {
    rows,
    async listProfiles() { return rows.map((row) => ({ ...row })); },
    async getNextSpeakerLabel() {
      const used = new Set(rows.map((row) => row.label));
      let index = 1;
      while (used.has(`说话人 ${index}`)) index += 1;
      return `说话人 ${index}`;
    },
    async insertProfile(_db, _meetingId, label, featuresJson, sampleCount) {
      const row = { id: nextId++, label, featuresJson, sampleCount };
      rows.push(row);
      return { id: row.id };
    },
    async setProfileFeatures(_db, id, featuresJson, sampleCount) {
      const row = rows.find((item) => item.id === id);
      row.featuresJson = featuresJson;
      row.sampleCount = sampleCount;
    },
    async renameProfileLabel(_db, _meetingId, from, to) {
      rows.find((row) => row.label === from).label = to;
    },
    async deleteProfileById(_db, id) {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
  };
}

test("第一条声纹立即建立说话人 1，不显示待识别", async () => {
  const store = createMemoryStore();
  const manager = createMeetingSpeakerTrackManager(store);
  const [result] = await manager.resolveBatch({
    meetingId: 1,
    observations: [{ key: "realtime-1", embedding: vector(0), durationMs: 1800, source: "embedding" }],
  });
  assert.equal(result.speaker, "说话人 1");
  assert.equal(result.status, "confirmed");
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 1);
});

test("短时不匹配声纹只建隐藏候选，沿用当前人且不爆增可见人数", async () => {
  const store = createMemoryStore([{
    label: "说话人 1",
    featuresJson: JSON.stringify({ kind: "embedding", vector: vector(0), status: "confirmed" }),
  }]);
  const manager = createMeetingSpeakerTrackManager(store);
  const [result] = await manager.resolveBatch({
    meetingId: 2,
    fallbackLabel: "说话人 1",
    observations: [{ key: "noise", embedding: vector(1), durationMs: 900, source: "embedding" }],
  });
  assert.equal(result.speaker, "说话人 1");
  assert.equal(result.status, "provisional");
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 1);
  assert.equal(store.rows.filter((row) => row.label.startsWith("__candidate_")).length, 1);
});

test("同一 45 秒窗口的两条强轨道一对一映射为两个会议说话人", async () => {
  const store = createMemoryStore([{
    label: "说话人 1",
    featuresJson: JSON.stringify({ kind: "embedding", vector: vector(0), status: "confirmed" }),
  }]);
  const manager = createMeetingSpeakerTrackManager(store);
  const results = await manager.resolveBatch({
    meetingId: 3,
    observations: [
      { key: "speaker_0", embedding: [0.99, 0.01, 0, 0], durationMs: 8000, evidenceCount: 3, source: "rolling_diarization" },
      { key: "speaker_1", embedding: vector(1), durationMs: 9000, evidenceCount: 4, source: "rolling_diarization" },
    ],
  });
  assert.deepEqual(results.map((item) => item.speaker), ["说话人 1", "说话人 2"]);
  assert.equal(new Set(results.map((item) => item.speaker)).size, 2);
});

test("分离模型把同一人拆成两条高相似轨道时复用同一会议说话人", async () => {
  const store = createMemoryStore([{
    label: "说话人 1",
    featuresJson: JSON.stringify({ kind: "embedding", vector: vector(0), status: "confirmed" }),
  }]);
  const manager = createMeetingSpeakerTrackManager(store);
  const results = await manager.resolveBatch({
    meetingId: 31,
    observations: [
      { key: "speaker_0", embedding: [0.999, 0.01, 0, 0], durationMs: 8000, evidenceCount: 3, source: "rolling_diarization" },
      { key: "speaker_1", embedding: [0.998, 0.02, 0, 0], durationMs: 6000, evidenceCount: 2, source: "rolling_diarization" },
    ],
  });
  assert.deepEqual(results.map((item) => item.speaker), ["说话人 1", "说话人 1"]);
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 1);
});

test("同时接近两个已有说话人时保持临时归属且不创建新人", async () => {
  const store = createMemoryStore([
    { label: "说话人 1", featuresJson: JSON.stringify({ kind: "embedding", vector: [1, 0.05, 0, 0] }) },
    { label: "说话人 2", featuresJson: JSON.stringify({ kind: "embedding", vector: [1, -0.05, 0, 0] }) },
  ]);
  const manager = createMeetingSpeakerTrackManager(store);
  const [result] = await manager.resolveBatch({
    meetingId: 32,
    fallbackLabel: "说话人 1",
    confirmNewTracks: true,
    observations: [{ key: "ambiguous", embedding: vector(0), durationMs: 9000, evidenceCount: 4, source: "rolling_diarization" }],
  });
  assert.equal(result.speaker, "说话人 1");
  assert.equal(result.status, "provisional");
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 2);
  assert.equal(store.rows.filter((row) => row.label.startsWith("__candidate_")).length, 0);
});

test("跨窗口临时编号互换时仍按声纹保持会议级身份", async () => {
  const store = createMemoryStore([
    { label: "说话人 1", featuresJson: JSON.stringify({ kind: "embedding", vector: vector(0) }) },
    { label: "说话人 2", featuresJson: JSON.stringify({ kind: "embedding", vector: vector(1) }) },
  ]);
  const manager = createMeetingSpeakerTrackManager(store);
  const results = await manager.resolveBatch({
    meetingId: 4,
    observations: [
      { key: "window-local-0", embedding: vector(1), durationMs: 6000, evidenceCount: 2, source: "rolling_diarization" },
      { key: "window-local-1", embedding: vector(0), durationMs: 6000, evidenceCount: 2, source: "rolling_diarization" },
    ],
  });
  assert.deepEqual(results.map((item) => item.speaker), ["说话人 2", "说话人 1"]);
});
