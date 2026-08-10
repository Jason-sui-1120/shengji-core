import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
const moduleBase = existsSync(new URL("../modules/transcript-composer.mjs", import.meta.url))
  ? "../modules/"
  : "./";
const {
  buildAbsoluteTimedWords,
  composeCanonicalFileSegments,
  planSpeakerTurnSplits,
} = await import(new URL(`${moduleBase}transcript-composer.mjs`, import.meta.url));
const { shouldMapSpeechClock } = await import(new URL(`${moduleBase}rolling-window-plan.mjs`, import.meta.url));

test("文件模型接近请求尾部结束时不得误判为静音压缩时钟", () => {
  assert.equal(shouldMapSpeechClock({
    requestDurationMs: 54_100,
    sourceSpeechDurationMs: 45_300,
    modelEndMs: 50_230,
  }), false);
});

test("模型与有效语音时长一致且均明显短于请求时才使用语音时钟", () => {
  assert.equal(shouldMapSpeechClock({
    requestDurationMs: 60_000,
    sourceSpeechDurationMs: 40_000,
    modelEndMs: 40_500,
  }), true);
});

test("文件片段按绝对时间排序并强制单调", () => {
  const result = composeCanonicalFileSegments([
    { text: "第二句", startMs: 2_500, endMs: 4_000 },
    { text: "第一句", startMs: 1_000, endMs: 3_000 },
  ]);
  assert.deepEqual(result.map((item) => item.text), ["第一句", "第二句"]);
  assert.equal(result[1].startMs, 3_000);
  assert.ok(result[1].endMs > result[1].startMs);
});

test("跨窗口重复文件片段只保留一份", () => {
  const result = composeCanonicalFileSegments([
    { text: "我们下周完成业务验收。", startMs: 1_000, endMs: 3_000 },
    { text: "我们下周完成业务验收", startMs: 2_700, endMs: 4_200 },
  ]);
  assert.equal(result.length, 1);
});

test("边界消重只接受连续前后缀，不能按零散相同字删掉新句", () => {
  const result = composeCanonicalFileSegments([{
    text: "挨门挨户介绍并安排人员，但是需要支付工资。",
    startMs: 10_500,
    endMs: 15_000,
  }], {
    windowStartMs: 10_000,
    windowEndMs: 20_000,
    precedingRows: [{
      text: "郊区房子价格实惠，宣传也需要持续推进。",
      audioEndMs: 10_000,
    }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "挨门挨户介绍并安排人员，但是需要支付工资。");
});

test("新窗口开头重复上一稳定稿尾部时先去重，再执行时间单调", () => {
  const result = composeCanonicalFileSegments([{
    text: "完成业务验收。然后安排上线验证。",
    startMs: 45_000,
    endMs: 50_000,
  }], {
    windowStartMs: 45_000,
    windowEndMs: 90_000,
    precedingRows: [{
      text: "完成业务验收。",
      audioStartMs: 40_000,
      audioEndMs: 45_200,
      speakerSource: "file_asr",
    }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "然后安排上线验证。");
  assert.ok(result[0].startMs > 45_000);
});

test("时间不相邻的相同表达不得作为边界重复删除", () => {
  const result = composeCanonicalFileSegments([{
    text: "完成业务验收。然后安排上线验证。",
    startMs: 45_000,
    endMs: 50_000,
  }], {
    precedingRows: [{
      text: "完成业务验收。",
      audioStartMs: 10_000,
      audioEndMs: 20_000,
      speakerSource: "file_asr",
    }],
  });
  assert.equal(result[0].text, "完成业务验收。然后安排上线验证。");
});

test("人工编辑覆盖的时间区间不再插入自动文件稿", () => {
  const result = composeCanonicalFileSegments([
    { text: "自动识别文本", startMs: 5_000, endMs: 8_000 },
  ], {
    protectedRows: [{
      audioStartMs: 5_500,
      audioEndMs: 7_500,
      userEdited: 1,
      speakerSource: "manual",
    }],
  });
  assert.deepEqual(result, []);
});

test("片段时间被约束在本次可提交窗口内", () => {
  const result = composeCanonicalFileSegments([
    { text: "窗口内容", startMs: 500, endMs: 9_500 },
  ], { windowStartMs: 1_000, windowEndMs: 9_000 });
  assert.equal(result[0].startMs, 1_000);
  assert.equal(result[0].endMs, 9_000);
});

test("不同文本即使上游时间重叠也不删字，只调整时间边界", () => {
  const result = composeCanonicalFileSegments([
    { text: "先确认权限范围", startMs: 1_000, endMs: 3_000 },
    { text: "再推进主体授权", startMs: 2_500, endMs: 4_500 },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[1].startMs, result[0].endMs);
  assert.equal(result[1].text, "再推进主体授权");
});

test("词级时间戳使用窗口起点转换到会议绝对时间", () => {
  const words = buildAbsoluteTimedWords([
    { word: "你好", start: 1.2, end: 1.8 },
  ], { windowStartMs: 45_000 });
  assert.deepEqual(words, [{ text: "你好", startMs: 46_200, endMs: 46_800 }]);
});

test("可靠词级文字与说话人轨道可以把稳定行按真实切换点拆开", () => {
  const rows = [{
    id: 1,
    text: "你好，大家好。",
    audioStartMs: 1_000,
    audioEndMs: 5_000,
    userEdited: 0,
    speakerSource: "file_asr",
  }];
  const words = [
    { text: "你好", startMs: 1_100, endMs: 2_000 },
    { text: "大家好", startMs: 3_000, endMs: 4_800 },
  ];
  const speakers = [
    { speaker: "speaker_1", absoluteStartMs: 1_000, absoluteEndMs: 2_500 },
    { speaker: "speaker_2", absoluteStartMs: 2_500, absoluteEndMs: 5_000 },
  ];
  const mapping = new Map([
    ["speaker_1", { speaker: "张三", confidence: 91 }],
    ["speaker_2", { speaker: "李四", confidence: 88 }],
  ]);
  const plans = planSpeakerTurnSplits(rows, words, speakers, mapping);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].groups.map((group) => [group.speaker, group.text]), [
    ["张三", "你好，"],
    ["李四", "大家好。"],
  ]);
});

test("逐词稿未完整覆盖稳定文字时禁止猜测拆行", () => {
  const plans = planSpeakerTurnSplits([{
    id: 1,
    text: "你好，今天讨论主体授权。",
    audioStartMs: 0,
    audioEndMs: 5_000,
  }], [
    { text: "你好", startMs: 0, endMs: 1_000 },
    { text: "主体授权", startMs: 3_000, endMs: 5_000 },
  ], [
    { speaker: "s1", absoluteStartMs: 0, absoluteEndMs: 2_000 },
    { speaker: "s2", absoluteStartMs: 2_000, absoluteEndMs: 5_000 },
  ], new Map([
    ["s1", { speaker: "张三", confidence: 90 }],
    ["s2", { speaker: "李四", confidence: 90 }],
  ]));
  assert.deepEqual(plans, []);
});

test("同一说话人覆盖整行时不制造多余分行", () => {
  const plans = planSpeakerTurnSplits([{
    id: 1,
    text: "你好大家好",
    audioStartMs: 0,
    audioEndMs: 3_000,
  }], [
    { text: "你好", startMs: 0, endMs: 1_000 },
    { text: "大家好", startMs: 1_000, endMs: 3_000 },
  ], [{ speaker: "s1", absoluteStartMs: 0, absoluteEndMs: 3_000 }], new Map([
    ["s1", { speaker: "张三", confidence: 90 }],
  ]));
  assert.deepEqual(plans, []);
});
