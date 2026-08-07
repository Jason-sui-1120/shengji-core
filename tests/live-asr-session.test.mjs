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
const { RollingTranscriptService, boundSegmentsToCommitWindow } = await import(rollingModuleUrl);

test("文件段触及中心区右边界时不得生成零时长稳定稿", () => {
  const bounded = boundSegmentsToCommitWindow([
    { text: "中心区内的有效句子", startMs: 599_700, endMs: 600_100 },
    { text: "右边界属于下一窗口", startMs: 600_000, endMs: 600_300 },
  ], { commitStartMs: 555_000, commitEndMs: 600_000 });

  assert.deepEqual(bounded.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })), [
    { text: "中心区内的有效句子", startMs: 599_700, endMs: 600_000 },
  ]);
});

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

test("尾段 deadline 后返回的文件稿不得再写入稳定稿", async () => {
  const controller = new AbortController();
  let storeWrites = 0;
  const fileResponse = {
    ok: true,
    text: JSON.stringify({ result: { text: "迟到的文件稿", segments: [{ text: "迟到的文件稿", start_time: 0, end_time: 1 }] } }),
  };
  const service = new RollingTranscriptService({
    createWindowRun: async () => { storeWrites += 1; return 1; },
    listWindowTranscriptRows: async () => { storeWrites += 1; return []; },
    getPreviousStableText: async () => "",
    insertFileAsrStableSegments: async () => { storeWrites += 1; return { insertedCount: 1, insertedIds: [1], stableRevision: 1 }; },
  }, {
    callFileTranscription: async () => {
      controller.abort();
      return fileResponse;
    },
    callFileTranscriptionByUrl: async () => {
      controller.abort();
      return fileResponse;
    },
  });

  await assert.rejects(
    service.correctWindow({
      meetingId: 78,
      pcm: Buffer.alloc(16000 * 2),
      windowStartAudioMs: 0,
      windowEndAudioMs: 1000,
      centerStartAudioMs: 0,
      centerEndAudioMs: 1000,
      abortSignal: controller.signal,
      getHotwords: async () => [],
    }),
    { name: "AbortError" },
  );
  assert.equal(storeWrites, 0, "deadline 后即使 ASR 返回成功，也不能删除或插入任何转写行");
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
    insertFileAsrStableSegments: async (_meetingId, payload) => {
      const { segments } = payload;
      calls.inserted.push(segments);
      calls.replaceExistingAutoRows = payload.replaceExistingAutoRows;
      return { insertedCount: segments.length, insertedIds: [9901], stableRevision: 19, deletedCount: 2 };
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

  assert.equal(result.alignmentMode, "file_canonical");
  assert.equal(result.insertedCount, 1);
  assert.equal(result.deletedCount, 2);
  assert.deepEqual(calls.deleted, [], "替换不能先在 service 层单独删除");
  assert.equal(calls.replaceExistingAutoRows, true, "adapter 必须在同一事务替换自动行");
  assert.equal(calls.inserted.length, 1);
  assert.equal(calls.inserted[0][0].text, "文件稿覆盖的第一句");
  assert.equal(calls.inserted[0][0].speaker, "说话人 1", "整体替换不得把已有说话人轨道退化为待识别");
  assert.equal(calls.inserted[0][0].speakerSource, "rolling_realtime_hint");
  assert.equal(calls.applied, 0);
  assert.deepEqual(calls.notifications, [{ meetingId: 91, stableRevision: 19 }]);
  assert.equal(calls.finalized[0][1], "file_canonical");
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

test("结束会议必须排空正在执行的滚动尾窗后，才能兜底实时草稿", async () => {
  const events = [];
  let resolveFirstCorrection;
  let correctionCalls = 0;
  const correctionAbortSignals = [];
  let forceCalls = 0;
  const deferredFirstCorrection = new Promise((resolve) => { resolveFirstCorrection = resolve; });
  const sealingClient = {
    readyState: FakeSocket.OPEN,
    sent: [],
    handlers: new Map(),
    on(name, handler) { this.handlers.set(name, handler); },
    send(value) { this.sent.push(value); },
    ping() {},
    close() { this.readyState = 3; },
  };
  const beforeSocketCount = FakeSocket.instances.length;
  await createLiveAsrSession(sealingClient, new URL("ws://localhost/api/asr/live?meetingId=89"), {
    WebSocket: FakeSocket,
    Buffer,
    randomUUID,
    meetingConnections: new Map(),
    config: {
      AIT_ASR_MODEL: "test",
      ROLLING_ASR_ENABLED: true,
      ROLLING_ASR_MODEL: "test-file",
      ROLLING_ASR_WINDOW_SECONDS: 1,
      ROLLING_ASR_OVERLAP_SECONDS: 0,
      ROLLING_ASR_MAX_LOOKBACK_SECONDS: 0,
      ROLLING_ASR_MAX_BOUNDARY_EXTENSION_SECONDS: 0,
      ROLLING_ASR_MIN_SECONDS: 0.5,
      ROLLING_ASR_TIMEOUT_MS: 1_000,
      ROLLING_ASR_MAX_RETRIES: 0,
      TAIL_STABILIZATION_TIMEOUT_MS: 2_000,
      POST_MEETING_SPEAKER_TIMEOUT_MS: 1_000,
      ASR_UPSTREAM_ROTATE_AFTER_MS: 0,
      ASR_GLOSSARY_TIMEOUT_MS: 10,
      ASR_FINAL_STABILITY_DELAY_MS: 0,
    },
    hasAiAccess: () => true,
    getMeetingLiveRecord: async () => ({ id: 89, status: "recording" }),
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
    markMeetingSourceAudioStabilizing: async () => {},
    finalizeMeetingSourceAudio: async (_meetingId, status, options) => {
      events.push(`source-finalized:${status}:${Boolean(options?.force)}`);
    },
    reconcileMeetingSpeakersFromSourceAudio: async () => ({ ok: true }),
    getAsrHotwordsForMeeting: () => [],
    getMeetingGlossaryEntries: () => [],
    uniqueStrings: (values) => [...new Set(values)],
    isFillerOnly: () => false,
    removeFillerWords: (text) => text,
    mergeTranscriptText: (previous, next) => `${previous}${next}`,
    applyGlossaryAliasCorrections: (text) => text,
    analyzePcmQuality: () => ({ durationMs: 0 }),
    savePcmAsWav: () => ({ audioPath: "", wav: null }),
    buildTranscriptLineDrafts: () => [],
    insertTranscript: async (line) => line,
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
    waitForMeetingAiJobs: async () => {},
    countDraftTranscripts: async () => 1,
    forceStabilizeDraftTranscripts: async () => {
      forceCalls += 1;
      events.push("force-realtime-fallback");
      return 1;
    },
    performRollingTranscriptCorrection: async ({ abortSignal }) => {
      correctionCalls += 1;
      correctionAbortSignals.push(abortSignal || null);
      events.push(`file-window-${correctionCalls}`);
      if (correctionCalls === 1) return deferredFirstCorrection;
      return { lastProcessedTranscriptId: 0 };
    },
    normalizeSpeechIntervals: (intervals) => intervals,
    buildRollingWindowPlan: ({ requestStartMs, availableEndMs, commitStartMs, isFinal, windowMs, rightContextMs }) => {
      if (availableEndMs <= commitStartMs + 250) return null;
      const targetEnd = commitStartMs + windowMs;
      if (isFinal && targetEnd >= availableEndMs) {
        return {
          requestStartMs,
          requestEndMs: availableEndMs,
          commitStartMs,
          commitEndMs: availableEndMs,
          trimLeadingSeconds: 0,
          trimTrailingSeconds: 0,
        };
      }
      if (!isFinal && availableEndMs >= targetEnd + rightContextMs) {
        return {
          requestStartMs,
          requestEndMs: targetEnd + rightContextMs,
          commitStartMs,
          commitEndMs: targetEnd,
          trimLeadingSeconds: 0,
          trimTrailingSeconds: rightContextMs / 1000,
        };
      }
      return null;
    },
    findRollingContextStart: ({ commitStartMs }) => commitStartMs,
  });

  const upstream = FakeSocket.instances.at(beforeSocketCount);
  upstream.emit("open");
  upstream.emit("message", JSON.stringify({ header: { name: "TranscriptionStarted" }, payload: {} }), false);
  // 2 秒音频先触发一个 1 秒会中文件窗口；该窗口故意保持未完成。
  sealingClient.handlers.get("message")(Buffer.alloc(2 * 16000 * 2, 1), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(correctionCalls, 1);

  // 用户此时点击结束。旧实现会立即把 draft 强制升级，随后才插入剩余文件稿。
  sealingClient.handlers.get("message")("stop", false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(forceCalls, 0, "正在执行的会中文件窗口不能被当作已完成");

  events.push("first-window-resolved");
  resolveFirstCorrection({ lastProcessedTranscriptId: 0 });
  for (let attempt = 0; attempt < 50 && forceCalls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(correctionCalls >= 2, "封存必须继续处理剩余尾窗");
  assert.ok(correctionAbortSignals[1] instanceof AbortSignal, "会中已启动窗口递归出的尾窗必须继承封存 deadline");
  assert.equal(forceCalls, 1, "所有尾窗排空后才能用实时稿兜底");
  assert.ok(events.indexOf("force-realtime-fallback") > events.lastIndexOf(`file-window-${correctionCalls}`));
  assert.ok(events.includes("source-finalized:complete:true"), "用户主动结束必须强制封存完整源录音");
  sealingClient.handlers.get("close")();
});
