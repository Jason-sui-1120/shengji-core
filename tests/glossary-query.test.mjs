import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

// core 内测试位于 tests/；同步到端侧后位于 server/。同一份测试必须验证
// 两个位置的共享实现，而不是在消费者仓库复制第二份测试。
const coreModuleUrl = new URL("../modules/glossary-query.mjs", import.meta.url);
const { selectAsrHotwords } = await import(existsSync(coreModuleUrl)
  ? "../modules/glossary-query.mjs"
  : "./glossary-query.mjs");

test("ASR 热词按已排序优先级去重并同时遵守数量与字符预算", () => {
  const hotwords = selectAsrHotwords([
    { term: "高优先级术语", aliases: ["高优先级别名", "重复词"] },
    { term: "重复词", aliases: ["次级别名"] },
    { term: "尾部词", aliases: [] },
  ], { maxCount: 3, maxChars: 20 });

  assert.deepEqual(hotwords, ["高优先级术语", "高优先级别名", "重复词"]);
  assert.ok(hotwords.join(",").length <= 20);
});

test("ASR 热词字符预算会跳过超额项并继续尝试后续短词", () => {
  const hotwords = selectAsrHotwords([
    { term: "超出剩余预算的长术语", aliases: [] },
    { term: "短词", aliases: [] },
  ], { maxCount: 5, maxChars: 4 });

  assert.deepEqual(hotwords, ["短词"]);
});
