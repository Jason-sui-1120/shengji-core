// transcript-align-zero-overlap.test.mjs —— 零重叠片段分配防护回归测试。
// 银标重复主因之一：前一窗口尾部内容与所有候选实时行零重叠时，
// 此前会被强行分配给"距离最近"的行，拼进本窗稳定稿。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
const moduleBase = existsSync(new URL("../modules/transcript-align.mjs", import.meta.url))
  ? "../modules/"
  : "./";
const { alignFileSegmentsToRowsByAbsoluteTime } = await import(new URL(`${moduleBase}transcript-align.mjs`, import.meta.url));

const ROWS = [
  { id: 12458, text: "当前窗口的实时草稿", audioStartMs: 239_580, audioEndMs: 268_410 },
  { id: 12459, text: "当前窗口第二行", audioStartMs: 268_410, audioEndMs: 290_000 },
];

function makeFileResult(segments) {
  return { segments: segments.map(([start, end, text]) => ({ start, end, text })) };
}

test("零重叠片段不得分配给任何实时行（前一窗口内容被跳过）", () => {
  // 文件 ASR 返回的片段：一个在前一窗口（226.9s–239.58s），一个在当前窗口
  const fileResult = makeFileResult([
    [0, 12.6, "前一窗口的内容"],       // 绝对时间 222.9s–235.5s，与候选行零重叠
    [16.7, 45.5, "当前窗口的内容"],    // 绝对时间 239.6s–268.4s，有重叠
  ]);
  const result = alignFileSegmentsToRowsByAbsoluteTime(
    ROWS, fileResult, 0, 222_900, "", 0, 81_000,
    { commitStartMs: 239_580, commitEndMs: 268_410 },
  );
  // 第一行只应包含当前窗口内容，不得拼入前一窗口文本
  for (const line of result) {
    assert.ok(!line.text.includes("前一窗口的内容"), `行 ${line.id} 不得包含前一窗口内容: ${line.text}`);
  }
});

test("全部片段零重叠时返回原始行文本（不拼接任何文件片段）", () => {
  const fileResult = makeFileResult([
    [0, 5, "完全不属于本窗口的内容"],
  ]);
  const result = alignFileSegmentsToRowsByAbsoluteTime(
    ROWS, fileResult, 0, 222_900, "", 0, 81_000,
    { commitStartMs: 222_900, commitEndMs: 303_900 }, // 不过滤，靠零重叠防护
  );
  assert.equal(result[0].text, "当前窗口的实时草稿");
  assert.equal(result[0].fileSegmentCount, 0);
  assert.equal(result[1].text, "当前窗口第二行");
  assert.equal(result[1].fileSegmentCount, 0);
});

test("有重叠的片段正常分配（防误伤主流程）", () => {
  const fileResult = makeFileResult([
    [16.7, 45.5, "当前窗口的内容"],
  ]);
  const result = alignFileSegmentsToRowsByAbsoluteTime(
    ROWS, fileResult, 0, 222_900, "", 0, 81_000,
    { commitStartMs: 239_580, commitEndMs: 268_410 },
  );
  assert.equal(result[0].text, "当前窗口的内容");
  assert.equal(result[0].fileSegmentCount, 1);
});

test("中心提交区间过滤：区间外片段在分配前就被剔除", () => {
  const fileResult = makeFileResult([
    [0, 12.6, "前置重叠区内容"],      // rawStart < commitStart
    [16.7, 45.5, "中心区内容"],
  ]);
  const result = alignFileSegmentsToRowsByAbsoluteTime(
    ROWS, fileResult, 0, 222_900, "", 0, 81_000,
    { commitStartMs: 239_580, commitEndMs: 268_410 },
  );
  assert.equal(result[0].text, "中心区内容");
  assert.ok(!result[0].text.includes("前置重叠区内容"));
});
