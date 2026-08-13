import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { test } from "node:test";

// 同一测试会被 sync-core 复制到消费端 server/；兼容核心仓库与消费端两种目录。
const moduleUrl = existsSync(new URL("../modules/live-asr-session.mjs", import.meta.url))
  ? new URL("../modules/live-asr-session.mjs", import.meta.url)
  : new URL("./live-asr-session.mjs", import.meta.url);
const { createLiveAsrSession, getUncommittedCumulativeText, getUpstreamReconnectPlan, shouldSuppressLiveTranscriptDuplicate } = await import(moduleUrl);
const rollingModuleUrl = existsSync(new URL("../modules/rolling-transcript-service.mjs", import.meta.url))
  ? new URL("../modules/rolling-transcript-service.mjs", import.meta.url)
  : new URL("./rolling-transcript-service.mjs", import.meta.url);
const {
  RollingTranscriptService,
  boundSegmentsToCommitWindow,
} = await import(rollingModuleUrl);
const helpersModuleUrl = existsSync(new URL("../modules/live-asr-helpers.mjs", import.meta.url))
  ? new URL("../modules/live-asr-helpers.mjs", import.meta.url)
  : new URL("./live-asr-helpers.mjs", import.meta.url);
const { clampMeetingTranscriptTimeline } = await import(helpersModuleUrl);

test("文件段触及中心区右边界时不得生成零时长稳定稿", () => {
  const bounded = boundSegmentsToCommitWindow([
    { text: "中心区内的有效句子", startMs: 599_700, endMs: 600_100 },
    { text: "右边界属于下一窗口", startMs: 600_000, endMs: 600_300 },
  ], { commitStartMs: 555_000, commitEndMs: 600_000 });

  assert.deepEqual(bounded.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })), [
    { text: "中心区内的有效句子", startMs: 599_700, endMs: 600_000 },
  ]);
});

test("封存时超出源音频终点的自动稳定稿合并到前一条尾部，不能留下零时长行或丢字", () => {
  const rows = [
    {
      id: 1, text: "最后一条稳定稿", rawText: "最后一条原始稿", correctionText: "最后一条校正稿",
      audioStartMs: 590_000, audioEndMs: 600_000, audioDurationMs: 10_000, userEdited: 0,
    },
    {
      id: 2, text: "尾部未落轴文字", rawText: "尾部原始文字", correctionText: "尾部校正文字",
      audioStartMs: 600_000, audioEndMs: 600_000, audioDurationMs: 2_000, userEdited: 0,
    },
  ];
  const updated = [];
  const merged = [];
  const discarded = [];
  const db = {
    prepare(sql) {
      if (sql.includes("SELECT id, text, raw_text")) return { all: () => rows };
      if (sql.includes("SET audio_start_ms")) return { run: (...values) => updated.push(values) };
      if (sql.includes("SET text = ?")) return { run: (...values) => merged.push(values) };
      if (sql.includes("SET deleted_at")) return { run: (...values) => discarded.push(values) };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  clampMeetingTranscriptTimeline(db, 7, 600_000);

  assert.deepEqual(updated, []);
  assert.deepEqual(merged, [["最后一条稳定稿尾部未落轴文字", "最后一条原始稿尾部原始文字", "最后一条校正稿尾部校正文字", 1, 7]]);
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0][1], 2);
  assert.equal(discarded[0][2], 7);
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

test("流式累计 SentenceEnd 与 partial-progress 重叠时只保留一条草稿", () => {
  assert.equal(shouldSuppressLiveTranscriptDuplicate(
    { text: "我换你换你，这几个这几个团队没定这个", audioStartMs: 11_000, audioEndMs: 18_000, reason: "partial_progress" },
    { text: "我换你换你，这几个这几个团队没定", audioStartMs: 18_000, audioEndMs: 19_000, reason: "sentence_end" },
  ), true, "partial-progress 后的近似 SentenceEnd 不能再插一条");

  assert.equal(shouldSuppressLiveTranscriptDuplicate(
    { text: "这是一条完整的确认句。", audioStartMs: 10_000, audioEndMs: 12_000, reason: "sentence_end" },
    { text: "这是一条完整的确认句", audioStartMs: 12_300, audioEndMs: 13_000, reason: "sentence_end" },
  ), true, "相邻重发的 SentenceEnd 不能重复落库");

  assert.equal(shouldSuppressLiveTranscriptDuplicate(
    { text: "我们本周继续推进项目。", audioStartMs: 10_000, audioEndMs: 12_000, reason: "sentence_end" },
    { text: "我们本周重新评估预算。", audioStartMs: 12_300, audioEndMs: 14_000, reason: "sentence_end" },
  ), false, "相邻但内容不同的真实发言必须保留");
});

test("累计 partial 跨浏览器 VAD 端点时只返回未落轴尾部", () => {
  assert.equal(
    getUncommittedCumulativeText(
      "测试的话这个场景没有覆盖真实人员",
      "测试的话这个场景没有覆盖真实人员，所以角色掉落以后下游没有发现",
    ),
    "，所以角色掉落以后下游没有发现",
  );
  assert.equal(
    getUncommittedCumulativeText(
      "项目应该有一个完整的 checklist。",
      "项目应该有一个完整的checklist，这个 checklist 需要人事和 UC 全部确认。",
    ),
    "，这个 checklist 需要人事和 UC 全部确认。",
  );
  assert.equal(
    getUncommittedCumulativeText(
      "大家各个销售交过来咱简单做一下交流，我简单也把上个月这个上期整个销售的情况。",
      "大家各个销售交过来咱简单做一下交流，我简单也把上个月这个上期股整个收入的情况给大家做一下，我说明后续安排。",
    ),
    "给大家做一下，我说明后续安排。",
    "累计快照中间回改少量词时也只能提交新增尾部",
  );
  assert.equal(
    getUncommittedCumulativeText(
      "大家各个销售交过来咱简单做一下交流，我简单也把上个月这个上期股整个收入的情况给大家做一下，我说明那上个消息收入啊明天这个收。",
      "大家各个销售交过来咱简单做一下交流，我简单也把上个月这个上级部这个销售的情况也给大家做一下呃说明，咱上面销售销售啊明显的销售的状态不太好，没有达到咱们的销售金额或者销售目标。",
    ),
    "的状态不太好，没有达到咱们的销售金额或者销售目标。",
    "线上口语长句大幅回改时也不能再次提交整句",
  );
  assert.equal(
    getUncommittedCumulativeText("这是已经落轴的完整句子", "这是已经落轴的完整句子。"),
    "",
  );
  assert.equal(
    getUncommittedCumulativeText("上一句话已经结束", "这是完全不同的新一句"),
    "这是完全不同的新一句",
  );
});

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

test("文件 ASR 只返回全文 text 时，必须借实时 VAD 时间轴生成稳定稿而非整窗失败", async () => {
  const calls = { finalized: [], inserted: [] };
  const fileText = "文件模型只提供全文文字，但稳定稿仍然需要按原有时间轴展示。";
  const rows = [
    { id: 601, text: "实时草稿一", speaker: "说话人 1", speakerSource: "rolling_diarization", audioStartMs: 1_000, audioEndMs: 2_000 },
    { id: 602, text: "实时草稿二", speaker: "待识别", audioStartMs: 2_000, audioEndMs: 4_000 },
  ];
  const service = new RollingTranscriptService({
    createWindowRun: async () => 21,
    finalizeWindowRun: async (...args) => { calls.finalized.push(args); },
    listWindowTranscriptRows: async () => rows,
    getPreviousStableText: async () => "",
    insertFileAsrStableSegments: async (_meetingId, payload) => {
      calls.inserted.push(payload);
      return { insertedCount: payload.segments.length, insertedIds: [7001, 7002], stableRevision: 11, deletedCount: 2 };
    },
  }, {
    callFileTranscription: async () => ({ ok: true, text: JSON.stringify({ result: { text: fileText } }) }),
    callFileTranscriptionByUrl: async () => ({ ok: true, text: JSON.stringify({ result: { text: fileText } }) }),
  });

  const result = await service.correctWindow({
    meetingId: 79,
    pcm: Buffer.alloc(4 * 16000 * 2),
    startTranscriptId: 600,
    endTranscriptId: 602,
    windowStartAudioMs: 0,
    windowEndAudioMs: 4_000,
    centerStartAudioMs: 1_000,
    centerEndAudioMs: 4_000,
    getHotwords: async () => [],
  });

  assert.equal(result.alignmentMode, "file_text_timing_fallback");
  assert.equal(result.insertedCount, 2);
  assert.equal(calls.finalized[0][1], "file_text_timing_fallback");
  assert.equal(calls.inserted.length, 1);
  assert.deepEqual(
    calls.inserted[0].segments.map(({ startMs, endMs }) => ({ startMs, endMs })),
    [{ startMs: 1_000, endMs: 2_000 }, { startMs: 2_000, endMs: 4_000 }],
  );
  assert.equal(calls.inserted[0].segments.map((segment) => segment.text).join(""), fileText);
  assert.equal(calls.inserted[0].segments[0].speaker, "说话人 1");
  assert.equal(calls.inserted[0].segments[0].speakerSource, "rolling_diarization");
});

test("text-only 文件稿跨窗口只裁连续前后缀，不能重复插入上一稳定稿", async () => {
  const calls = [];
  const service = new RollingTranscriptService({
    insertFileAsrStableSegments: async (_meetingId, payload) => {
      calls.push(payload);
      return { insertedCount: payload.segments.length, insertedIds: [8001], stableRevision: 12, deletedCount: 1 };
    },
  });
  const result = await service.replaceWindowWithFileSegments({
    meetingId: 80,
    fileResult: { text: "上一窗口已确认的稳定文字，本窗口新增内容。" },
    fallbackText: "上一窗口已确认的稳定文字，本窗口新增内容。",
    previousStableText: "上一窗口已确认的稳定文字，",
    speakerRows: [{ audioStartMs: 4_000, audioEndMs: 7_000 }],
    windowStartAudioMs: 4_000,
    windowEndAudioMs: 7_000,
    effectiveWindowStartMs: 4_000,
    effectiveWindowEndMs: 7_000,
  });
  assert.equal(result.usedTextTimingFallback, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].segments.length, 1);
  assert.equal(calls[0].segments[0].text, "本窗口新增内容。");
  assert.ok(calls[0].segments[0].startMs > 4_000);
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

test("SentenceEnd 即使没有浏览器 VAD endpoint 也必须独立、低延迟落为草稿", async () => {
  const inserted = [];
  const speakerUpdates = [];
  let resolveSpeaker;
  const speakerResult = new Promise((resolve) => { resolveSpeaker = resolve; });
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
    // 词库预热即使慢，也不能阻塞已确认句末进入持久化时间轴。
    getAsrHotwordsForMeeting: () => new Promise((resolve) => setTimeout(() => resolve(["慢词"]), 200)),
    getMeetingGlossaryEntries: () => new Promise((resolve) => setTimeout(() => resolve([]), 200)),
    uniqueStrings: (values) => [...new Set(values)],
    isFillerOnly: () => false,
    removeFillerWords: (text) => text,
    mergeTranscriptText: (previous, next) => `${previous}${next}`,
    applyGlossaryAliasCorrections: (text) => text,
    analyzePcmQuality: (chunks) => ({
      durationMs: Math.round(chunks.reduce((sum, chunk) => sum + Number(chunk?.length || 0), 0) / 32),
    }),
    // 草稿路径不再依赖这些重型步骤；一旦回归到关键路径，测试应立即失败。
    savePcmAsWav: () => { throw new Error("草稿不得写分段 WAV"); },
    buildTranscriptLineDrafts: ({ text, audioStartMs, audioEndMs, fallbackSpeaker }) => [{
      id: 8801,
      time: "00:00",
      text,
      speaker: fallbackSpeaker.speaker,
      speakerSource: fallbackSpeaker.source,
      audioStartMs,
      audioEndMs,
      stabilityStatus: "draft",
    }],
    insertTranscript: async (line) => { inserted.push(line); return line; },
    shouldFlushTranscriptBuffer: () => false,
    looksSemanticallyIncomplete: () => false,
    shouldWaitForMoreSpeech: () => false,
    identifySpeakerFromAudio: () => speakerResult,
    updateTranscriptSpeakerAuto: async (id, speaker, confidence, source) => {
      speakerUpdates.push({ id, speaker, confidence, source });
      return { ...inserted.find((line) => line.id === id), speaker, speakerConfidence: confidence, speakerSource: source };
    },
    diarizeSpeakerSegments: () => { throw new Error("草稿不得等待实时分离"); },
    correctTranscriptText: () => { throw new Error("草稿不得等待实时 LLM"); },
    scheduleServerAutoAnalyze: () => {},
    appendMeetingSourceAudio: () => {},
    beginMeetingAiJob: () => {},
    endMeetingAiJob: () => {},
  });

  const upstream = FakeSocket.instances.at(beforeSocketCount);
  upstream.emit("open");
  upstream.emit("message", JSON.stringify({ header: { name: "TranscriptionStarted" }, payload: {} }), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 1.2 秒 PCM 足以触发后台声纹，但不得阻塞 SentenceEnd 草稿落库。
  realtimeClient.handlers.get("message")(Buffer.alloc(38_400, 1), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 不发送 vad.speech_start / vad.endpoint，直接模拟上游已经确认句末。
  const sentenceEndAt = Date.now();
  upstream.emit("message", JSON.stringify({
    header: { name: "SentenceEnd" },
    payload: { result: "这条确认句末必须进入草稿列表。", begin_time: 0, end_time: 1200 },
  }), false);
  // 紧接下一句开始也不得取消 SentenceEnd 已登记的落库 deadline。
  realtimeClient.handlers.get("message")(JSON.stringify({ type: "vad.speech_start" }), false);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(inserted.length, 1);
  assert.ok(Date.now() - sentenceEndAt < 150, "确认句末不应被慢词库或后台 AI 阻塞");
  assert.equal(inserted[0].text, "这条确认句末必须进入草稿列表。");
  assert.equal(inserted[0].speaker, "说话人 1", "首条草稿应立即落到暂定会议轨道，不能长时间显示待识别");
  assert.equal(speakerUpdates.length, 0, "声纹未返回时草稿已经可见，不能等待后台识别");
  assert.ok(realtimeClient.sent.some((item) => {
    const message = JSON.parse(item);
    return message.type === "transcript.final" && message.line?.text === "这条确认句末必须进入草稿列表。";
  }));
  assert.equal(realtimeClient.sent.some((item) => JSON.parse(item).type === "transcript.realtime_segment"), false);
  resolveSpeaker({ speaker: "说话人 2", confidence: 86, source: "embedding", speakerStatus: "confirmed" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(speakerUpdates, [{ id: 8801, speaker: "说话人 2", confidence: 86, source: "embedding" }]);
  assert.ok(realtimeClient.sent.some((item) => {
    const message = JSON.parse(item);
    return message.type === "transcript.final" && message.line?.id === 8801 && message.line?.speaker === "说话人 2";
  }), "声纹完成后应复用同一 transcript id 原位纠正，而不是新增一行");
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
    buildTranscriptLineDrafts: () => {
      events.push("draft-built");
      return [];
    },
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

  // StopTranscription 生效前，上游仍可能晚到最后一个 SentenceEnd。seal 已经用
  // 当时的缓冲做尾段收口，这个晚到结果不能再写成一条重复实时草稿。
  upstream.emit("message", JSON.stringify({
    header: { name: "SentenceEnd" },
    payload: { result: "结束后晚到的句末不能再次落库", begin_time: 1_000, end_time: 2_000 },
  }), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.includes("draft-built"), false, "停止后的晚到 SentenceEnd 必须被丢弃");

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
