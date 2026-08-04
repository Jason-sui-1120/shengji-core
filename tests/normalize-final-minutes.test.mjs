// normalizeFinalMinutes 真实调用回归测试——直接 import core 真实函数（非复制逻辑）
// 覆盖"测试全绿、纪要为空"的盲区：验证真实 normalizeFinalMinutes 在合理 AI 输入下产出非空纪要
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeFinalMinutes } from "./normalize-final-minutes.mjs";

const transcripts = [
  { id: 1, time: "00:00", speaker: "说话人 1", text: "销售量不高的反而就是没上去该人家那个别的地方的广告儿宣传做到了吧" },
  { id: 2, time: "00:47", speaker: "说话人 1", text: "一般这个学区房那个价格都偏高一点儿是吧 所以说销售还稍微" },
  { id: 3, time: "00:58", speaker: "说话人 2", text: "家庭都还会考虑一下价位上的一个但是它是一个学区房挺好的" },
  { id: 12, time: "05:30", speaker: "说话人 1", text: "那我们就确定加大优惠力度，由张三负责跟进" },
];

describe("normalizeFinalMinutes 真实调用", () => {
  test("合理 AI 输入产出非空纪要（不全是空兜底）", () => {
    const ai = {
      overview: "本次会议聚焦学区房营销策略与广告投放优化[T1][T2]",
      topics: [
        { title: "学区房销售", bullets: ["学区房价格偏高[T2]", "广告宣传需加强[T1]"] },
      ],
      timelineChapters: [{ startTime: "00:00", title: "开场", summary: "讨论销售现状" }],
      decisions: ["加大优惠力度[T12]"],
      risks: ["价格偏高影响销量[T2]"],
      openQuestions: [],
      quoteMoments: [{ quote: "那我们就确定加大优惠力度", speaker: "说话人 1", reason: "明确决策" }],
      speakerViewpoints: [{ speaker: "说话人 1", viewpoints: ["学区房价格偏高[T2]"] }],
    };
    const result = normalizeFinalMinutes(ai, [], transcripts);
    assert.ok(result.overview && !result.overview.startsWith("本次会议已归档"), "overview 不应是空兜底");
    assert.ok(result.overview.includes("学区房营销"), "overview 应含实际内容");
    assert.ok(result.topics.length > 0, "topics 不应为空");
    assert.ok(result.decisions.length > 0, "decisions 不应为空（有决策语气+证据）");
    assert.ok(result.quoteMoments.length > 0, "quoteMoments 不应为空");
    assert.ok(result.speakerViewpoints.length > 0, "speakerViewpoints 不应为空");
  });

  test("无证据的 decisions 被过滤", () => {
    const ai = { decisions: ["凭空捏造的决策，转写里没有"] };
    const result = normalizeFinalMinutes(ai, [], transcripts);
    assert.equal(result.decisions.length, 0, "无证据决策应被过滤");
  });

  test("overview 套话被替换为兜底", () => {
    const ai = { overview: "本次会议已归档" };
    const result = normalizeFinalMinutes(ai, [], transcripts);
    assert.ok(result.overview.startsWith("本次会议已归档"), "套话应被替换为兜底");
  });

  test("overview 带证据的总结性表述通过（不逐字复述）", () => {
    const ai = { overview: "会议围绕学区房价格与促销策略展开[T2][T12]" };
    const result = normalizeFinalMinutes(ai, [], transcripts);
    assert.ok(!result.overview.startsWith("本次会议已归档"), "带证据总结应通过");
    assert.ok(!result.overview.includes("[T"), "展示应清理 [T数字] 标记");
  });

  test("risks 需证据，无证据被过滤", () => {
    const ai = { risks: ["学区房那个价格都偏高[T2]", "完全编造的风险"] };
    const result = normalizeFinalMinutes(ai, [], transcripts);
    assert.equal(result.risks.length, 1, "只保留有证据的风险");
    assert.ok(result.risks[0].includes("价格都偏高"), "应保留 T2 证据风险");
  });

  test("actionUpdates 待办需证据 source", () => {
    const ai = {};
    const actions = [
      { title: "加大优惠力度", owner: "张三", due: "下周", status: "confirmed", source: "那我们就确定加大优惠力度[T12]" },
      { title: "无证据待办", owner: "待确认", due: "待确认", status: "candidate", source: "" },
    ];
    const result = normalizeFinalMinutes(ai, actions, transcripts);
    assert.ok(result.actionUpdates.length >= 1, "有证据待办应保留");
    assert.ok(result.actionUpdates.every((a) => a.source), "保留的待办应有 source");
  });

  test("空 AI 输入返回安全兜底结构", () => {
    const result = normalizeFinalMinutes({}, [], transcripts);
    assert.ok(typeof result.overview === "string");
    assert.ok(Array.isArray(result.topics));
    assert.ok(Array.isArray(result.decisions));
    assert.ok(Array.isArray(result.actionUpdates));
  });

  test("speakerViewpoints 未知说话人归为未知发言人", () => {
    const ai = {
      speakerViewpoints: [
        { speaker: "说话人 1", viewpoints: ["学区房价格偏高[T2]"] },
        { speaker: "转写里不存在的人", viewpoints: ["学区房价格偏高[T2]"] },
      ],
    };
    const result = normalizeFinalMinutes(ai, [], transcripts);
    const unknown = result.speakerViewpoints.find((s) => s.speaker === "未知发言人");
    assert.ok(unknown, "转写外的说话人应归为未知发言人");
  });

  test("transcripts 为空数组时不崩溃", () => {
    const ai = { overview: "测试", topics: [{ title: "a", bullets: ["b"] }] };
    const result = normalizeFinalMinutes(ai, [], []);
    assert.ok(typeof result.overview === "string");
  });

  test("transcripts 缺省（undefined）不崩溃", () => {
    const result = normalizeFinalMinutes({ overview: "x" }, []);
    assert.ok(typeof result.overview === "string");
  });
});
