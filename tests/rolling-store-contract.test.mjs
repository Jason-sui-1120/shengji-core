// rolling-store-contract.test.mjs —— RollingStore 接口契约测试（两端 store 实现都必须满足）。
// 不依赖真实 DB：验证接口完整性、参数/返回形状、空输入边界。
// 真实数据一致性由 1070 基准 fixture + 集成测试覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { ROLLING_STORE_METHODS, assertRollingStore } from "./rolling-store.mjs";

const EXPECTED_METHODS = [
  "createWindowRun",
  "finalizeWindowRun",
  "deleteWindowTranscriptRows",
  "listWindowTranscriptRows",
  "getPreviousStableText",
  "applyStableCorrection",
  "insertFileAsrStableSegments",
  "applySpeakerEnrichment",
  "getMeetingSourceAudioInfo",
  "getLatestTranscriptId",
];

test("RollingStore 接口方法清单稳定（10 个，防漂移）", () => {
  assert.deepEqual([...ROLLING_STORE_METHODS].sort(), [...EXPECTED_METHODS].sort());
});

test("assertRollingStore 拒绝缺方法的实现", () => {
  const incomplete = { createWindowRun: async () => 1 };
  assert.throws(() => assertRollingStore(incomplete), /RollingStore/);
});

test("assertRollingStore 接受完整实现", () => {
  const complete = Object.fromEntries(EXPECTED_METHODS.map((m) => [m, async () => null]));
  const store = assertRollingStore(complete);
  assert.equal(typeof store.createWindowRun, "function");
  assert.equal(Object.keys(store).length, 10);
});

// 按端测各自的 store 实现（公网 SQLite / 公司 MySQL），存在才测。
const storeModule = await (async () => {
  try {
    const m = await import("./mysql-rolling-store.mjs");
    return { name: "MySQL", create: m.createMysqlRollingStore };
  } catch {
    const m = await import("./sqlite-rolling-store.mjs");
    return { name: "SQLite", create: m.createSqliteRollingStore };
  }
})();

test(`${storeModule.name} store 实现满足接口契约`, async () => {
  const store = storeModule.create();
  for (const method of EXPECTED_METHODS) {
    assert.equal(typeof store[method], "function", `缺少方法 ${method}`);
  }
});

test("applySpeakerEnrichment 空输入短路（不触碰 DB）", async () => {
  const store = storeModule.create();
  const result = await store.applySpeakerEnrichment(1, { transcriptIds: [], assignments: [], splitPlans: [] });
  assert.deepEqual(result, { updatedCount: 0, splitRowCount: 0, insertedRowCount: 0, stableRevision: 0 });
});
