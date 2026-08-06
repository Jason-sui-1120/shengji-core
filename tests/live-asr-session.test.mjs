import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";

// 同一测试会被 sync-core 复制到消费端 server/；兼容核心仓库与消费端两种目录。
const moduleUrl = existsSync(new URL("../modules/live-asr-session.mjs", import.meta.url))
  ? new URL("../modules/live-asr-session.mjs", import.meta.url)
  : new URL("./live-asr-session.mjs", import.meta.url);
const { createLiveAsrSession, getUpstreamReconnectPlan } = await import(moduleUrl);

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
  constructor() { this.readyState = FakeSocket.OPEN; this.handlers = new Map(); }
  on(name, handler) { this.handlers.set(name, handler); }
  send() {}
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
