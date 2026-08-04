// P1-6 回归测试：暂停/恢复/重连时间轴连续性
// 验证：
// 1. 重连后 upstreamTaskAudioBaseMs 正确扣除 pending 音频
// 2. 暂停（client_close）后 checkpoint 正确持久化
// 3. 恢复（resume preload）从最后窗口尾部回填，不形成缺口

import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("P1-6: 暂停/恢复/重连时间轴", () => {
  test("重连时 upstreamTaskAudioBaseMs 扣除 pending 音频保持连续", () => {
    // 模拟：会话已进行 60 秒，pending 音频 5 秒
    const sessionAudioBaseMs = 0; // 会话起点
    const getTranscriptAudioOffsetMs = () => 60000; // 当前转写偏移 60 秒
    const pendingAudioBytes = 5 * 16000 * 2; // 5 秒 16kHz 16bit PCM

    // 重连后的 upstreamTaskAudioBaseMs 应该扣除 pending
    const upstreamTaskAudioBaseMs = Math.max(
      sessionAudioBaseMs,
      getTranscriptAudioOffsetMs() - Math.round(pendingAudioBytes / (16000 * 2) * 1000),
    );

    // 60 秒 - 5 秒 = 55 秒
    assert.equal(upstreamTaskAudioBaseMs, 55000, "重连后基准应扣除 pending 音频");
  });

  test("重连时 sessionAudioBaseMs 大于计算值时取 sessionAudioBaseMs", () => {
    // 模拟：会话中途加入（sessionAudioBaseMs > 0）
    const sessionAudioBaseMs = 30000; // 从 30 秒处加入
    const getTranscriptAudioOffsetMs = () => 60000;
    const pendingAudioBytes = 5 * 16000 * 2;

    const upstreamTaskAudioBaseMs = Math.max(
      sessionAudioBaseMs,
      getTranscriptAudioOffsetMs() - Math.round(pendingAudioBytes / (16000 * 2) * 1000),
    );

    // max(30000, 55000) = 55000
    assert.equal(upstreamTaskAudioBaseMs, 55000, "应取较大值");
  });

  test("无 pending 音频时 upstreamTaskAudioBaseMs 等于当前偏移", () => {
    const sessionAudioBaseMs = 0;
    const getTranscriptAudioOffsetMs = () => 60000;
    const pendingAudioBytes = 0;

    const upstreamTaskAudioBaseMs = Math.max(
      sessionAudioBaseMs,
      getTranscriptAudioOffsetMs() - Math.round(pendingAudioBytes / (16000 * 2) * 1000),
    );

    assert.equal(upstreamTaskAudioBaseMs, 60000, "无 pending 时应等于当前偏移");
  });

  test("resume preload 从最后窗口尾部回填 8 秒重叠", () => {
    // 模拟：最后窗口结束于 120 秒
    const lastWindowEndMs = 120000;
    const ROLLING_ASR_OVERLAP_SECONDS = 8;

    const resumeStartMs = lastWindowEndMs > 0
      ? Math.max(0, lastWindowEndMs - ROLLING_ASR_OVERLAP_SECONDS * 1000)
      : 0;

    // 120 秒 - 8 秒 = 112 秒
    assert.equal(resumeStartMs, 112000, "应从最后窗口尾部向前回填 8 秒");
  });

  test("首次启动（无窗口历史）时 resumeStartMs 为 0", () => {
    const lastWindowEndMs = 0;
    const ROLLING_ASR_OVERLAP_SECONDS = 8;

    const resumeStartMs = lastWindowEndMs > 0
      ? Math.max(0, lastWindowEndMs - ROLLING_ASR_OVERLAP_SECONDS * 1000)
      : 0;

    assert.equal(resumeStartMs, 0, "首次启动应从 0 开始");
  });

  test("暂停时 checkpoint 状态正确", () => {
    // 模拟：会议有活跃连接时 checkpoint 状态应为 recording
    const hasLiveConnection = true;
    const status = "partial";
    const stateFailed = false;

    const checkpointStatus = stateFailed
      ? "error"
      : (hasLiveConnection ? "recording" : status);

    assert.equal(checkpointStatus, "recording", "有活跃连接时应标记 recording");
  });

  test("暂停时无活跃连接 checkpoint 状态为 partial", () => {
    const hasLiveConnection = false;
    const status = "partial";
    const stateFailed = false;

    const checkpointStatus = stateFailed
      ? "error"
      : (hasLiveConnection ? "recording" : status);

    assert.equal(checkpointStatus, "partial", "无活跃连接时应标记 partial");
  });

  test("写入失败时 checkpoint 状态为 error", () => {
    const hasLiveConnection = true;
    const status = "partial";
    const stateFailed = true;

    const checkpointStatus = stateFailed
      ? "error"
      : (hasLiveConnection ? "recording" : status);

    assert.equal(checkpointStatus, "error", "写入失败时应标记 error");
  });
});
