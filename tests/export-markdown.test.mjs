// export-markdown 契约测试：Markdown 格式化工具
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  formatTopicMarkdown, formatTimelineMarkdown, formatListMarkdown,
  formatQuoteMarkdown, formatSpeakerViewpointMarkdown, formatActionMarkdown,
  formatExportTime, safeFileName,
} from "./export-markdown.mjs";
describe("formatTopicMarkdown", () => {
  test("空数组返回占位", () => {
    assert.deepEqual(formatTopicMarkdown([]), ["暂无议题纪要。"]);
  });
  test("正常议题", () => {
    const out = formatTopicMarkdown([{ title: "议题A", bullets: ["要点1", "要点2"] }]);
    assert.ok(out.includes("### 议题A"));
    assert.ok(out.includes("- 要点1"));
  });
});

describe("formatTimelineMarkdown", () => {
  test("空数组返回占位", () => {
    assert.deepEqual(formatTimelineMarkdown([]), ["- 暂无时间轴章节。"]);
  });
  test("正常章节", () => {
    const out = formatTimelineMarkdown([{ startTime: "10:00", title: "开场", summary: "介绍" }]);
    assert.equal(out[0], "- 10:00 开场：介绍");
  });
});

describe("formatListMarkdown", () => {
  test("空数组返回 emptyText", () => {
    assert.deepEqual(formatListMarkdown([], "暂无"), ["- 暂无"]);
  });
  test("过滤空字符串", () => {
    assert.deepEqual(formatListMarkdown(["a", "", "  ", "b"], "暂无"), ["- a", "- b"]);
  });
});

describe("formatQuoteMarkdown", () => {
  test("空数组返回占位", () => {
    assert.deepEqual(formatQuoteMarkdown([]), ["- 暂无金句。"]);
  });
  test("含金句和说话人", () => {
    const out = formatQuoteMarkdown([{ quote: "好", speaker: "张三", reason: "精彩" }]);
    assert.equal(out[0], "- 「好」—— 张三。精彩");
  });
});

describe("formatSpeakerViewpointMarkdown", () => {
  test("空数组返回占位", () => {
    assert.deepEqual(formatSpeakerViewpointMarkdown([]), ["- 暂无发言人观点。"]);
  });
  test("正常观点", () => {
    const out = formatSpeakerViewpointMarkdown([{ speaker: "李四", viewpoints: ["观点1"] }]);
    assert.ok(out.includes("### 李四"));
    assert.ok(out.includes("- 观点1"));
  });
});

describe("formatActionMarkdown", () => {
  test("空数组返回占位", () => {
    assert.deepEqual(formatActionMarkdown([]), ["- 暂无待办。"]);
  });
  test("状态映射正确", () => {
    const out = formatActionMarkdown([{ title: "任务", owner: "王五", due: "明天", status: "confirmed" }]);
    assert.ok(out[0].includes("状态：已确认"));
    assert.ok(out[0].includes("负责人：王五"));
  });
  test("未知状态原样显示", () => {
    const out = formatActionMarkdown([{ title: "任务", status: "custom" }]);
    assert.ok(out[0].includes("状态：custom"));
  });
});

describe("formatExportTime", () => {
  test("空值返回未知", () => {
    assert.equal(formatExportTime(""), "未知");
    assert.equal(formatExportTime(null), "未知");
  });
  test("正常时间格式化", () => {
    const out = formatExportTime("2026-08-04T12:00:00Z");
    assert.ok(/2026/.test(out));
  });
});

describe("safeFileName", () => {
  test("移除非法字符", () => {
    assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
  });
  test("空值返回默认", () => {
    assert.equal(safeFileName(""), "会议纪要");
  });
  test("超长截断 80", () => {
    assert.ok(safeFileName("x".repeat(100)).length <= 80);
  });
});
