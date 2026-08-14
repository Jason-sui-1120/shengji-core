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

test("第一条短声纹立即显示说话人 1，但不抢占正式轨道", async () => {
  const store = createMemoryStore();
  const manager = createMeetingSpeakerTrackManager(store);
  const [result] = await manager.resolveBatch({
    meetingId: 1,
    observations: [{ key: "realtime-1", embedding: vector(0), durationMs: 1800, source: "embedding" }],
  });
  assert.equal(result.speaker, "说话人 1");
  assert.equal(result.status, "provisional");
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 0);
  assert.equal(store.rows.filter((row) => row.label.startsWith("__candidate_")).length, 1);
});

test("短实时声纹不污染首号，首个可靠文件轨道仍建立为说话人 1", async () => {
  const store = createMemoryStore();
  const manager = createMeetingSpeakerTrackManager(store);
  const [realtime] = await manager.resolveBatch({
    meetingId: 11,
    observations: [{ key: "realtime-noisy", embedding: vector(0), durationMs: 1600, source: "embedding" }],
  });
  const [stable] = await manager.resolveBatch({
    meetingId: 11,
    observations: [{
      key: "speaker_0",
      embedding: vector(1),
      durationMs: 30_000,
      longestContinuousMs: 18_000,
      evidenceCount: 3,
      source: "rolling_diarization",
    }],
  });
  assert.equal(realtime.speaker, "说话人 1");
  assert.equal(realtime.status, "provisional");
  assert.equal(stable.speaker, "说话人 1");
  assert.equal(stable.status, "confirmed");
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 1);
});

test("实时弱声纹可匹配已有说话人但不得改写已确认画像", async () => {
  const originalVector = [1, 0, 0, 0];
  const store = createMemoryStore([{
    label: "说话人 1",
    sampleCount: 5,
    featuresJson: JSON.stringify({ kind: "embedding", vector: originalVector, status: "confirmed", totalSpeechMs: 20_000 }),
  }]);
  const manager = createMeetingSpeakerTrackManager(store);
  const [realtime] = await manager.resolveBatch({
    meetingId: 12,
    observations: [{
      key: "realtime-weak",
      embedding: [0.8, 0.6, 0, 0],
      durationMs: 1_200,
      source: "embedding",
      allowProfileLearning: false,
    }],
  });

  assert.equal(realtime.speaker, "说话人 1");
  assert.equal(realtime.status, "confirmed");
  assert.equal(store.rows[0].sampleCount, 5);
  assert.deepEqual(JSON.parse(store.rows[0].featuresJson).vector, originalVector);

  await manager.resolveBatch({
    meetingId: 12,
    observations: [{
      key: "stable-track",
      embedding: [0.8, 0.6, 0, 0],
      durationMs: 8_000,
      evidenceCount: 3,
      source: "rolling_diarization",
      allowProfileLearning: true,
    }],
  });
  assert.equal(store.rows[0].sampleCount, 6, "可靠文件轨道仍应更新已确认画像");
  assert.notDeepEqual(JSON.parse(store.rows[0].featuresJson).vector, originalVector);
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

test("单次连续长发言可建立新轨道，不会永久停在待识别", async () => {
  const store = createMemoryStore([{
    label: "说话人 1",
    featuresJson: JSON.stringify({ kind: "embedding", vector: vector(0), status: "confirmed" }),
  }]);
  const manager = createMeetingSpeakerTrackManager(store);
  const [result] = await manager.resolveBatch({
    meetingId: 33,
    fallbackLabel: "说话人 1",
    observations: [{
      key: "speaker_1",
      embedding: vector(1),
      durationMs: 7_000,
      longestContinuousMs: 7_000,
      evidenceCount: 1,
      source: "rolling_diarization",
    }],
  });
  assert.equal(result.speaker, "说话人 2");
  assert.equal(result.status, "confirmed");
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 2);
});

test("单次短发言仍只进入隐藏候选，避免噪声制造新人", async () => {
  const store = createMemoryStore([{
    label: "说话人 1",
    featuresJson: JSON.stringify({ kind: "embedding", vector: vector(0), status: "confirmed" }),
  }]);
  const manager = createMeetingSpeakerTrackManager(store);
  const [result] = await manager.resolveBatch({
    meetingId: 34,
    fallbackLabel: "说话人 1",
    observations: [{
      key: "speaker_1",
      embedding: vector(1),
      durationMs: 4_500,
      longestContinuousMs: 4_500,
      evidenceCount: 1,
      source: "rolling_diarization",
    }],
  });
  assert.equal(result.speaker, "说话人 1");
  assert.equal(result.status, "provisional");
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 1);
  assert.equal(store.rows.filter((row) => row.label.startsWith("__candidate_")).length, 1);
});

test("重复实时弱声纹不会把隐藏候选晋升为正式说话人", async () => {
  const store = createMemoryStore();
  const manager = createMeetingSpeakerTrackManager(store);
  for (const key of ["draft-1", "draft-2", "draft-3", "draft-4"]) {
    const [result] = await manager.resolveBatch({
      meetingId: 35,
      observations: [{
        key,
        embedding: vector(1),
        durationMs: 3_000,
        evidenceCount: 1,
        source: "realtime_embedding",
        allowProfileLearning: false,
      }],
    });
    assert.equal(result.speaker, "说话人 1");
    assert.equal(result.status, "provisional");
  }
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 0);
  assert.equal(store.rows.filter((row) => row.label.startsWith("__candidate_")).length, 1);
  assert.equal(store.rows.find((row) => row.label.startsWith("__candidate_"))?.sampleCount, 1);

  const [confirmed] = await manager.resolveBatch({
    meetingId: 35,
    observations: [{
      key: "stable-track",
      embedding: vector(1),
      durationMs: 7_000,
      longestContinuousMs: 7_000,
      evidenceCount: 2,
      source: "rolling_diarization",
      allowProfileLearning: true,
    }],
  });
  assert.equal(confirmed.speaker, "说话人 1");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(store.rows.filter((row) => row.label.startsWith("说话人 ")).length, 1);
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
