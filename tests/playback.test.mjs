// playback 契约测试 —— 统一返回结构 + 健壮 cue 派生
import { test, describe } from "node:test";
import assert from "node:assert";
import {
  turnsForRange,
  getTranscriptAudioSortKey,
  sortTranscriptRowsByAudio,
  deriveCuePositionsFromSource,
  deriveCuePositionsFromChunks,
  buildMeetingPlayback,
} from "./playback.mjs";

describe("turnsForRange", () => {
  test("返回与区间重叠的说话人段", () => {
    const turns = [
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
      { startMs: 5000, endMs: 6000 },
    ];
    const result = turnsForRange(turns, 500, 2500);
    assert.equal(result.length, 2, "0-1000 和 2000-3000 与 500-2500 重叠");
  });

  test("空数组返回空", () => {
    assert.deepEqual(turnsForRange([], 0, 1000), []);
    assert.deepEqual(turnsForRange(null, 0, 1000), []);
  });
});

describe("getTranscriptAudioSortKey", () => {
  test("audioEndMs>0 用 audioStartMs", () => {
    assert.equal(getTranscriptAudioSortKey({ audioStartMs: 5000, audioEndMs: 6000 }), 5000);
  });

  test("无时间戳时从 audioPath 提取序号", () => {
    assert.equal(getTranscriptAudioSortKey({ audioPath: "meeting-1-42-abc.wav" }), 42);
  });

  test("完全无信息返回 MAX_SAFE_INTEGER", () => {
    assert.equal(getTranscriptAudioSortKey({}), Number.MAX_SAFE_INTEGER);
  });
});

describe("deriveCuePositionsFromSource 健壮降级", () => {
  test("audioStartMs>0 用真实值", () => {
    const rows = [
      { id: 1, audioStartMs: 1000, audioEndMs: 3000 },
      { id: 2, audioStartMs: 3000, audioEndMs: 5000 },
    ];
    const positions = deriveCuePositionsFromSource(rows, 60);
    assert.equal(positions.get(1).start, 1);
    assert.equal(positions.get(1).end, 3);
    assert.equal(positions.get(2).start, 3);
  });

  test("audioStartMs=0 脏数据用 fallbackCursor 降级（不错位）", () => {
    const rows = [
      { id: 1, audioStartMs: 1000, audioEndMs: 3000 },
      { id: 2, audioStartMs: 0, audioEndMs: 0, audioDurationMs: 2000 }, // 脏数据
      { id: 3, audioStartMs: 6000, audioEndMs: 8000 },
    ];
    const positions = deriveCuePositionsFromSource(rows, 60);
    assert.equal(positions.get(2).start, 3, "脏数据行从前一行的结束位置继续");
    assert.equal(positions.get(2).end, 5, "脏数据行用 audioDurationMs 推结束");
    assert.equal(positions.get(3).start, 6, "后续行不受影响");
  });

  test("超过时长被钳制", () => {
    const rows = [{ id: 1, audioStartMs: 50000, audioEndMs: 70000 }];
    const positions = deriveCuePositionsFromSource(rows, 60);
    assert.equal(positions.get(1).start, 50);
    assert.equal(positions.get(1).end, 60, "end 钳制到 durationSeconds");
  });
});

describe("deriveCuePositionsFromChunks 降级拼接", () => {
  test("按文本长度加权分配时间轴", () => {
    const rows = [
      { id: 1, text: "短", audioPath: "a.wav" },
      { id: 2, text: "这是一个比较长的文本内容", audioPath: "a.wav" },
    ];
    const resolve = () => ({ audioPath: "a.wav", durationSeconds: 10 });
    const { positions, totalSeconds, hasAudio } = deriveCuePositionsFromChunks(rows, resolve);
    assert.equal(totalSeconds, 10);
    assert.ok(hasAudio);
    assert.ok(positions.get(2).end - positions.get(2).start > positions.get(1).end - positions.get(1).start, "长文本分配更多时间");
  });

  test("无音频文件 hasAudio=false", () => {
    const rows = [{ id: 1, text: "测试", audioPath: "" }];
    const resolve = () => ({ audioPath: "", durationSeconds: 0 });
    const { hasAudio } = deriveCuePositionsFromChunks(rows, resolve);
    assert.equal(hasAudio, false);
  });
});

describe("buildMeetingPlayback 统一返回结构", () => {
  const baseDeps = {
    meetingExists: async () => true,
    listTranscriptRows: async () => [
      { id: 1, time: "00:01", speaker: "A", text: "第一句", audioStartMs: 1000, audioEndMs: 3000 },
      { id: 2, time: "00:03", speaker: "B", text: "第二句", audioStartMs: 3000, audioEndMs: 5000 },
    ],
    listSpeakerTurns: async () => [{ startMs: 1000, endMs: 3000, speaker: "A" }],
    getSourceAudioInfo: async () => ({ durationMs: 60000, status: "complete", audioBytes: 1000 }),
    buildAudioUrl: (id, has) => (has ? `/api/meetings/${id}/audio` : ""),
    resolveChunkAudio: () => ({ audioPath: "", durationSeconds: 0 }),
  };

  test("返回前端消费交集 {ok, audioUrl, cues}", async () => {
    const result = await buildMeetingPlayback(1, baseDeps);
    assert.equal(result.ok, true);
    assert.equal(result.audioUrl, "/api/meetings/1/audio");
    assert.ok(Array.isArray(result.cues));
    assert.equal(result.cues.length, 2);
    assert.equal(result.cues[0].id, 1);
    assert.equal(typeof result.cues[0].startSeconds, "number");
    assert.equal(typeof result.cues[0].endSeconds, "number");
  });

  test("会议不存在返回 ok:false", async () => {
    const result = await buildMeetingPlayback(999, { ...baseDeps, meetingExists: async () => false });
    assert.equal(result.ok, false);
    assert.deepEqual(result.cues, []);
  });

  test("有源音频走 source 路径", async () => {
    const result = await buildMeetingPlayback(1, baseDeps);
    assert.equal(result.durationSeconds, 60);
    assert.ok(result.sourceAudio);
  });

  test("无源音频走 chunk 降级路径", async () => {
    const result = await buildMeetingPlayback(1, { ...baseDeps, getSourceAudioInfo: async () => null });
    assert.equal(result.ok, true);
    assert.equal(result.audioUrl, "", "无音频时 audioUrl 为空");
  });
});
