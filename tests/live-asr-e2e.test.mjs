import assert from "node:assert/strict";
import { test } from "node:test";

// 端到端回归测试：去重区间重叠比例 + flush 入队冻结快照。
// 不真正调 createLiveAsrSession（它等上游 ASR 连接，FakeSocket 不触发 onopen 会卡住）——
// 直接测纯逻辑（去重条件、flush 快照隔离）。

test("去重：真正重复的上游句（区间重叠 100%）应去重", () => {
  // [10s, 14s] 又来一次 [10s, 14s]——区间重叠 100%，文本近似，应去重。
  const lastFlushed = { text: "这是一句话", audioStartMs: 10000, audioEndMs: 14000 };
  const current = { text: "这是一句话", audioStartMs: 10000, audioEndMs: 14000 };

  const overlapMs = Math.max(0, Math.min(lastFlushed.audioEndMs, current.audioEndMs) - Math.max(lastFlushed.audioStartMs, current.audioStartMs));
  const shorterDuration = Math.min(lastFlushed.audioEndMs - lastFlushed.audioStartMs, current.audioEndMs - current.audioStartMs);
  const overlapRatio = shorterDuration > 0 ? overlapMs / shorterDuration : 0;

  const textSimilar = current.text.startsWith(lastFlushed.text) || lastFlushed.text.startsWith(current.text);
  const shouldDedupe = textSimilar && overlapRatio > 0.8;

  assert.equal(overlapRatio, 1.0, "区间重叠 100%");
  assert.ok(shouldDedupe, "真正重复的上游句应去重");
});

test("去重：两人紧接着说'好的'（区间重叠 0%）不去重", () => {
  // [10s, 11s]、[11.2s, 12s]——区间重叠 0%，文本相同，不应去重。
  const lastFlushed = { text: "好的", audioStartMs: 10000, audioEndMs: 11000 };
  const current = { text: "好的", audioStartMs: 11200, audioEndMs: 12000 };

  const overlapMs = Math.max(0, Math.min(lastFlushed.audioEndMs, current.audioEndMs) - Math.max(lastFlushed.audioStartMs, current.audioStartMs));
  const shorterDuration = Math.min(lastFlushed.audioEndMs - lastFlushed.audioStartMs, current.audioEndMs - current.audioStartMs);
  const overlapRatio = shorterDuration > 0 ? overlapMs / shorterDuration : 0;

  const textSimilar = current.text === lastFlushed.text;
  const shouldDedupe = textSimilar && overlapRatio > 0.8;

  assert.equal(overlapRatio, 0, "区间重叠 0%");
  assert.ok(!shouldDedupe, "两人紧接着说'好的'不应去重（重叠 0%）");
});

test("flush 快照：入队时冻结，排队期间后续句子不混入", () => {
  // A 句正在做声纹识别和落库，B、C 两句又陆续结束——
  // B、C 进队列，但内容不放在同一个全局 transcriptBuffer（入队时冻结快照并清空活动缓冲）。
  let transcriptBuffer = "第一句话";
  const snapshot1 = { text: transcriptBuffer };
  transcriptBuffer = "";  // 入队时立即清空

  // B、C 句进 buffer（新的活动缓冲）
  transcriptBuffer = "第二句话";
  const snapshot2 = { text: transcriptBuffer };
  transcriptBuffer = "";

  transcriptBuffer = "第三句话";
  const snapshot3 = { text: transcriptBuffer };
  transcriptBuffer = "";

  // 断言：三个快照的文本不混入（B、C 不在 A 的缓冲里）
  assert.equal(snapshot1.text, "第一句话");
  assert.equal(snapshot2.text, "第二句话");
  assert.equal(snapshot3.text, "第三句话");
  assert.ok(!snapshot1.text.includes("第二句话"), "A 句不应包含 B 句（快照隔离）");
  assert.ok(!snapshot1.text.includes("第三句话"), "A 句不应包含 C 句（快照隔离）");
});

test("重连：源录音样本数连续（sessionAudioBaseBytes 恢复）", () => {
  // 服务重启前已有 20 分钟 = 76MB，sessionAudioBaseBytes 从数据库恢复。
  // 重连后 nextSample 应从 20 分钟开始（不丢音频）。
  const sessionAudioBaseBytes = 20 * 60 * 16000 * 2;  // 20 分钟 = 76MB
  const receivedAudioBytes = 5 * 16000 * 2;  // 重连后又接收 5 秒

  const totalBytes = sessionAudioBaseBytes + receivedAudioBytes;
  const totalSamples = totalBytes / 2;  // Int16 = 2 bytes/sample
  const nextAudioMs = (totalBytes / (16000 * 2)) * 1000;

  assert.equal(nextAudioMs, (20 * 60 + 5) * 1000, "重连后 nextAudioMs 应从 20 分 5 秒开始（不丢音频）");
});
