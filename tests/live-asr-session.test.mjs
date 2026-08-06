import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { test } from "node:test";

// 同一测试会被 sync-core 复制到消费端 server/；兼容核心仓库与消费端两种目录。
const moduleUrl = existsSync(new URL("../modules/live-asr-session.mjs", import.meta.url))
  ? new URL("../modules/live-asr-session.mjs", import.meta.url)
  : new URL("./live-asr-session.mjs", import.meta.url);
const { createLiveAsrSession, getUpstreamReconnectPlan } = await import(moduleUrl);
const rollingModuleUrl = existsSync(new URL("../modules/rolling-transcript-service.mjs", import.meta.url))
  ? new URL("../modules/rolling-transcript-service.mjs", import.meta.url)
  : new URL("./rolling-transcript-service.mjs", import.meta.url);
const { RollingTranscriptService } = await import(rollingModuleUrl);

// 1009 的关键不是“尽快重连”，而是等待 AIT 释放旧任务名额；否则 4 分钟轮换后
// 会持续撞并发上限，表现为实时转写完全停止。此处锁定 30s / 60s / 90s 的退避。
{
  const config = {
    ASR_UPSTREAM_ROTATION_COOLDOWN_MS: 35_000,
    ASR_CONCURRENCY_RETRY_BASE_MS: 30_000,
    ASR_CONCURRENCY_RETRY_MAX_MS: 90_000,
  };
  const first = getUpstreamReconnectPlan("too many connections", 1, config);
  const second = getUpstreamReconnectPlan("code 1009", 2, config);
  const capped = getUpstreamReconnectPlan("internal error", 4, config);
  const rotated = getUpstreamReconnectPlan("planned_task_rotation", 1, config);
  const ordinary = getUpstreamReconnectPlan("network reset", 1, config);
  assert.equal(first.delay, 30_000);
  assert.equal(second.delay, 60_000);
  assert.equal(capped.delay, 90_000);
  assert.equal(rotated.delay, 35_000);
  assert.equal(ordinary.delay, 800);
}

class FakeSocket {
  static OPEN = 1;
  static instances = [];
  constructor() {
    this.readyState = FakeSocket.OPEN;
    this.handlers = new Map();
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  on(name, handler) { this.handlers.set(name, handler); }
  emit(name, ...args) { return this.handlers.get(name)?.(...args); }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
  ping() {}
  pong() {}
}

const client = {
  readyState: FakeSocket.OPEN,
  sent: [],
  handlers: new Map(),
  on(name, handler) { this.handlers.set(name, handler); },
  send(value) { this.sent.push(value); },
  close() { this.readyState = 3; },
};

await createLiveAsrSession(client, new URL("ws://localhost/api/asr/live?meetingId=7"), {
  WebSocket: FakeSocket,
  Buffer,
  randomUUID,
  meetingConnections: new Map(),
  config: { AIT_ASR_MODEL: "test", ROLLING_ASR_ENABLED: false, ROLLING_ASR_MAX_RETRIES: 1 },
  hasAiAccess: () => true,
  getMeetingLiveRecord: async () => ({ id: 7, status: "recording" }),
  getFinalizedMeetingByMeetingId: async () => null,
  resolveRequestedAsrModel: () => "test",
  getAsrUpstreamUrl: () => "ws://upstream.example.test",
  ensureMeetingSourceAudio: () => ({ scheduledBytes: 0, bytes: 0 }),
  // 公司端不需要滚动恢复时允许返回空；共享会话必须自行转成标准空状态。
  loadRollingResumeAudio: () => null,
  getLatestTranscriptId: () => 0,
  normalizeTranscriptSegment: (text) => String(text || ""),
  persistMeetingElapsedSeconds: () => {},
  checkpointMeetingSourceAudio: async () => {},
});

assert.equal(client.readyState, FakeSocket.OPEN);
assert.ok(client.handlers.has("message"));
assert.ok(client.handlers.has("close"));
assert.ok(client.sent.some((item) => JSON.parse(item).status === "connecting"));
client.handlers.get("close")();
console.log("live-asr-session runtime dependency contract passed");

test("文件 ASR 直接插入稳定稿后必须通知自动分析", async () => {
  const notifications = [];
  const fileResponse = {
    ok: true,
    text: JSON.stringify({
      result: {
        text: "首条稳定转写已经生成。",
        segments: [{ text: "首条稳定转写已经生成。", start_time: 0.1, end_time: 3.8 }],
      },
    }),
  };
  const service = new RollingTranscriptService({
    createWindowRun: async () => 0,
    finalizeWindowRun: async () => {},
    listWindowTranscriptRows: async () => [],
    getPreviousStableText: async () => "",
    insertFileAsrStableSegments: async (_meetingId, { segments }) => ({
      insertedCount: segments.length,
      insertedIds: [501],
      stableRevision: 7,
    }),
  }, {
    callFileTranscription: async () => fileResponse,
    callFileTranscriptionByUrl: async () => fileResponse,
    afterStableCorrection: async (meetingId, stableRevision) => {
      notifications.push({ meetingId, stableRevision });
    },
  });

  const result = await service.correctWindow({
    meetingId: 77,
    pcm: Buffer.alloc(4 * 16000 * 2),
    startTranscriptId: 0,
    endTranscriptId: 0,
    windowStartAudioMs: 0,
    windowEndAudioMs: 4000,
    centerStartAudioMs: 0,
    centerEndAudioMs: 4000,
    getHotwords: async () => [],
  });

  assert.equal(result.insertedCount, 1);
  assert.equal(result.stableRevision, 7);
  assert.deepEqual(notifications, [{ meetingId: 77, stableRevision: 7 }]);
});

test("部分时间对齐必须整体替换稳定窗口，不能遗留实时残片", async () => {
  const calls = { deleted: [], inserted: [], finalized: [], applied: 0, notifications: [] };
  const rows = [
    {
      id: 901,
      text: "文件稿覆盖的第一句",
      speaker: "说话人 1",
      audioStartMs: 100,
      audioEndMs: 1900,
    },
    {
      id: 902,
      text: "未被文件稿覆盖的实时残片",
      speaker: "说话人 2",
      audioStartMs: 2100,
      audioEndMs: 3900,
    },
  ];
  const fileResponse = {
    ok: true,
    text: JSON.stringify({
      result: {
        text: "文件稿覆盖的第一句",
        segments: [{ text: "文件稿覆盖的第一句", start_time: 0.1, end_time: 1.9 }],
      },
    }),
  };
  const service = new RollingTranscriptService({
    createWindowRun: async () => 91,
    finalizeWindowRun: async (...args) => { calls.finalized.push(args); },
    listWindowTranscriptRows: async () => rows,
    getPreviousStableText: async () => "",
    deleteWindowTranscriptRows: async (...args) => { calls.deleted.push(args); return 2; },
    insertFileAsrStableSegments: async (_meetingId, { segments }) => {
      calls.inserted.push(segments);
      return { insertedCount: segments.length, insertedIds: [9901], stableRevision: 19 };
    },
    applyStableCorrection: async () => {
      calls.applied += 1;
      throw new Error("部分对齐不应只更新命中的实时行");
    },
  }, {
    callFileTranscription: async () => fileResponse,
    callFileTranscriptionByUrl: async () => fileResponse,
    afterStableCorrection: async (meetingId, stableRevision) => calls.notifications.push({ meetingId, stableRevision }),
  });

  const result = await service.correctWindow({
    meetingId: 91,
    pcm: Buffer.alloc(4 * 16000 * 2),
    startTranscriptId: 900,
    endTranscriptId: 902,
    windowStartAudioMs: 0,
    windowEndAudioMs: 4000,
    centerStartAudioMs: 0,
    centerEndAudioMs: 4000,
    getHotwords: async () => [],
  });

  assert.equal(result.alignmentMode, "file_replace_partial_alignment");
  assert.equal(result.insertedCount, 1);
  assert.equal(result.unmatchedCandidateCount, 1);
  assert.deepEqual(calls.deleted, [[91, 0, 4000]]);
  assert.equal(calls.inserted.length, 1);
  assert.equal(calls.inserted[0][0].text, "文件稿覆盖的第一句");
  assert.equal(calls.inserted[0][0].speaker, "说话人 1", "整体替换不得把已有说话人轨道退化为待识别");
  assert.equal(calls.inserted[0][0].speakerSource, "rolling_realtime_hint");
  assert.equal(calls.applied, 0);
  assert.deepEqual(calls.notifications, [{ meetingId: 91, stableRevision: 19 }]);
  assert.equal(calls.finalized[0][1], "file_replace_partial_alignment");
});

test("SentenceEnd 即使没有浏览器 VAD endpoint 也必须独立落为草稿", async () => {
  const inserted = [];
  const realtimeClient = {
    readyState: FakeSocket.OPEN,
    sent: [],
    handlers: new Map(),
    on(name, handler) { this.handlers.set(name, handler); },
    send(value) { this.sent.push(value); },
    ping() {},
    close() { this.readyState = 3; },
  };
  const beforeSocketCount = FakeSocket.instances.length;
  await createLiveAsrSession(realtimeClient, new URL("ws://localhost/api/asr/live?meetingId=88"), {
    WebSocket: FakeSocket,
    Buffer,
    randomUUID,
    meetingConnections: new Map(),
    config: {
      AIT_ASR_MODEL: "test",
      ROLLING_ASR_ENABLED: false,
      ROLLING_ASR_MAX_RETRIES: 1,
      ASR_FINAL_STABILITY_DELAY_MS: 15,
      ASR_UPSTREAM_ROTATE_AFTER_MS: 0,
      ASR_GLOSSARY_TIMEOUT_MS: 10,
    },
    hasAiAccess: () => true,
    getMeetingLiveRecord: async () => ({ id: 88, status: "recording" }),
    getFinalizedMeetingByMeetingId: async () => null,
    resolveRequestedAsrModel: () => "test",
    getAsrUpstreamUrl: () => "ws://upstream.example.test",
    ensureMeetingSourceAudio: () => ({ scheduledBytes: 0, bytes: 0 }),
    loadRollingResumeAudio: () => null,
    getLatestTranscriptId: () => 0,
    normalizeTranscriptSegment: (text) => String(text || "").trim(),
    formatMeetingElapsedTime: (seconds) => `00:${String(Math.floor(Number(seconds) || 0)).padStart(2, "0")}`,
    normalizeTranscriptDraftTimeline: (_meetingId, lines) => lines,
    persistMeetingElapsedSeconds: () => {},
    checkpointMeetingSourceAudio: async () => {},
    getAsrHotwordsForMeeting: () => [],
    getMeetingGlossaryEntries: () => [],
    uniqueStrings: (values) => [...new Set(values)],
    isFillerOnly: () => false,
    removeFillerWords: (text) => text,
    mergeTranscriptText: (previous, next) => `${previous}${next}`,
    applyGlossaryAliasCorrections: (text) => text,
    analyzePcmQuality: () => ({ durationMs: 0 }),
    savePcmAsWav: () => ({ audioPath: "", wav: null }),
    buildTranscriptLineDrafts: ({ text, audioStartMs, audioEndMs }) => [{
      id: 8801,
      time: "00:00",
      text,
      speaker: "待识别",
      audioStartMs,
      audioEndMs,
      stabilityStatus: "draft",
    }],
    insertTranscript: async (line) => { inserted.push(line); return line; },
    shouldFlushTranscriptBuffer: () => false,
    looksSemanticallyIncomplete: () => false,
    shouldWaitForMoreSpeech: () => false,
    identifySpeakerFromAudio: () => null,
    diarizeSpeakerSegments: () => [],
    correctTranscriptText: ({ text }) => text,
    scheduleServerAutoAnalyze: () => {},
    appendMeetingSourceAudio: () => {},
    beginMeetingAiJob: () => {},
    endMeetingAiJob: () => {},
  });

  const upstream = FakeSocket.instances.at(beforeSocketCount);
  upstream.emit("open");
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 不发送 vad.speech_start / vad.endpoint，直接模拟上游已经确认句末。
  upstream.emit("message", JSON.stringify({
    header: { name: "SentenceEnd" },
    payload: { result: "这条确认句末必须进入草稿列表。", begin_time: 0, end_time: 1200 },
  }), false);
  // 紧接下一句开始也不得取消 SentenceEnd 已登记的落库 deadline。
  realtimeClient.handlers.get("message")(JSON.stringify({ type: "vad.speech_start" }), false);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].text, "这条确认句末必须进入草稿列表。");
  assert.ok(realtimeClient.sent.some((item) => {
    const message = JSON.parse(item);
    return message.type === "transcript.final" && message.line?.text === "这条确认句末必须进入草稿列表。";
  }));
  realtimeClient.handlers.get("close")();
});
