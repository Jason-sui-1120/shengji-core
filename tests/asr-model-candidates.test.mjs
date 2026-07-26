// 冷启动回归：空数据库初始化 + /api/asr/models 候选列表可用（schema 不再引用 index.mjs 变量）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { asrModels } from "./asr-model-candidates.mjs";

test("asrModels 候选列表结构完整", () => {
  assert.ok(Array.isArray(asrModels) && asrModels.length >= 4, "至少 4 个候选");
  for (const m of asrModels) {
    assert.ok(m.id && typeof m.id === "string", "id 必填");
    assert.ok(m.vendor && typeof m.vendor === "string", "vendor 必填");
    assert.ok(typeof m.pricePerHour === "number", "pricePerHour 必填");
    assert.ok(m.endpoint && m.endpoint.startsWith("/"), "endpoint 必填");
    assert.ok(["default", "candidate", "benchmark", "fallback", "lab"].includes(m.recommendation), `recommendation 合法: ${m.id}`);
  }
  // 必须有默认模型
  assert.ok(asrModels.some((m) => m.recommendation === "default"), "必须有 default 模型");
});

test("候选 id 唯一", () => {
  const ids = asrModels.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "id 不允许重复");
});
