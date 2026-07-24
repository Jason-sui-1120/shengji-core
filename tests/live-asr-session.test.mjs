import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";

// 同一测试会被 sync-core 复制到消费端 server/；兼容核心仓库与消费端两种目录。
const moduleUrl = existsSync(new URL("../modules/live-asr-session.mjs", import.meta.url))
  ? new URL("../modules/live-asr-session.mjs", import.meta.url)
  : new URL("./live-asr-session.mjs", import.meta.url);
const { createLiveAsrSession } = await import(moduleUrl);

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
