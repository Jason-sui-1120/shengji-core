// fake-ai 契约测试：统一的可控 AI 响应工具
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeChatCompletion, createFakeFinalMinutes, createFakeParseJsonContent, aiErrorScenarios } from "./fake-ai.mjs";

describe("createFakeChatCompletion", () => {
  test("默认返回包装好的 gateway 响应", async () => {
    const fake = createFakeChatCompletion();
    const r = await fake({ model: "test", messages: [{ role: "user", content: "你好" }] });
    assert.ok(r.ok);
    const parsed = JSON.parse(r.text);
    assert.ok(parsed.choices?.[0]?.message?.content !== undefined);
  });

  test("按关键词匹配响应", async () => {
    const fake = createFakeChatCompletion({
      responses: { "会议纪要": '{"overview":"会议讨论"}' },
    });
    const r = await fake({ model: "test", messages: [{ role: "user", content: "生成会议纪要" }] });
    const parsed = JSON.parse(r.text);
    assert.equal(JSON.parse(parsed.choices[0].message.content).overview, "会议讨论");
  });

  test("fail 模式返回错误", async () => {
    const fake = createFakeChatCompletion({ fail: true });
    const r = await fake({ model: "test", messages: [] });
    assert.equal(r.ok, false);
  });

  test("记录调用供断言", async () => {
    const fake = createFakeChatCompletion();
    await fake({ model: "m1", messages: [{ role: "user", content: "test" }] });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].model, "m1");
  });
});

describe("createFakeFinalMinutes", () => {
  test("返回默认纪要结构", async () => {
    const fake = createFakeFinalMinutes();
    const r = await fake({});
    assert.ok(r.ok);
    assert.ok(r.data.overview);
    assert.ok(Array.isArray(r.data.topics));
  });

  test("合并自定义纪要", async () => {
    const fake = createFakeFinalMinutes({ overview: "自定义概述" });
    const r = await fake({});
    assert.equal(r.data.overview, "自定义概述");
  });
});

describe("createFakeParseJsonContent", () => {
  test("按关键词映射", () => {
    const fake = createFakeParseJsonContent({ "key": { result: 1 } });
    assert.deepEqual(fake("含key的文本"), { result: 1 });
  });

  test("无映射时尝试 JSON.parse", () => {
    const fake = createFakeParseJsonContent();
    assert.deepEqual(fake('{"a":1}'), { a: 1 });
    assert.deepEqual(fake("非JSON"), {});
  });
});

describe("aiErrorScenarios", () => {
  test("包含标准错误场景", () => {
    assert.ok(aiErrorScenarios.gatewayError);
    assert.ok(aiErrorScenarios.invalidJson);
    assert.ok(aiErrorScenarios.emptyChoices);
    assert.ok(aiErrorScenarios.emptyContent);
    assert.ok(aiErrorScenarios.nonObjectJson);
  });

  test("gatewayError 是 502", () => {
    assert.equal(aiErrorScenarios.gatewayError.ok, false);
    assert.equal(aiErrorScenarios.gatewayError.status, 502);
  });
});
