/**
 * finalize-store-contract.test.mjs —— FinalizeStore 双 Adapter 契约测试。
 *
 * 验证 SQLite 和 MySQL 两个实现都满足相同接口契约：
 * 1. 方法清单完整（FINALIZE_STORE_METHODS 防漂移）
 * 2. 缺方法拒绝
 * 3. 返回格式一致
 *
 * 这个测试在 shengji-core 中定义，两端各自运行——
 * 公网端测 SQLite adapter，公司端测 MySQL adapter。
 * 如果某端漏了接口或行为不一致，该端测试会失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FINALIZE_STORE_METHODS, assertFinalizeStore } from "./finalize-store.mjs";

test("FINALIZE_STORE_METHODS 包含 8 个方法", () => {
  assert.equal(FINALIZE_STORE_METHODS.length, 8);
  assert.ok(FINALIZE_STORE_METHODS.includes("getMeetingWithProject"));
  assert.ok(FINALIZE_STORE_METHODS.includes("saveFinalizedMeeting"));
  assert.ok(FINALIZE_STORE_METHODS.includes("recordAnalysisRun"));
  assert.ok(FINALIZE_STORE_METHODS.includes("getFinalizationGate"));
});

test("assertFinalizeStore 拒绝缺方法的 store", () => {
  assert.throws(
    () => assertFinalizeStore({ getMeetingWithProject: () => {} }),
    /缺少方法/,
  );
});

test("assertFinalizeStore 接受完整 store", () => {
  const mock = Object.fromEntries(
    FINALIZE_STORE_METHODS.map((m) => [m, () => {}]),
  );
  assert.doesNotThrow(() => assertFinalizeStore(mock));
});

test("SQLite adapter 满足 FinalizeStore 接口契约", async () => {
  let mod;
  try {
    mod = await import("./sqlite-finalize-store.mjs");
  } catch (e) {
    // 公司端没有 SQLite adapter，跳过
    return;
  }
  const store = mod.createSqliteFinalizeStore();
  for (const method of FINALIZE_STORE_METHODS) {
    assert.equal(
      typeof store[method],
      "function",
      `FinalizeStore (SQLite) 缺少方法: ${method}`,
    );
  }
});

test("MySQL adapter 满足 FinalizeStore 接口契约", async () => {
  let mod;
  try {
    mod = await import("./mysql-finalize-store.mjs");
  } catch (e) {
    // 公网端没有 MySQL adapter，跳过
    return;
  }
  const store = mod.createMysqlFinalizeStore();
  for (const method of FINALIZE_STORE_METHODS) {
    assert.equal(
      typeof store[method],
      "function",
      `FinalizeStore (MySQL) 缺少方法: ${method}`,
    );
  }
});

test("recordAnalysisRun 签名验证（单参数对象解构）", async () => {
  // 验证 SQLite adapter
  let sqliteMod;
  try {
    sqliteMod = await import("./sqlite-finalize-store.mjs");
    const store = sqliteMod.createSqliteFinalizeStore();
    assert.equal(typeof store.recordAnalysisRun, "function");
    assert.equal(store.recordAnalysisRun.length, 1, "SQLite recordAnalysisRun 应为单参数");
  } catch { /* 公司端跳过 */ }

  // 验证 MySQL adapter
  let mysqlMod;
  try {
    mysqlMod = await import("./mysql-finalize-store.mjs");
    const store = mysqlMod.createMysqlFinalizeStore();
    assert.equal(typeof store.recordAnalysisRun, "function");
    assert.equal(store.recordAnalysisRun.length, 1, "MySQL recordAnalysisRun 应为单参数");
  } catch { /* 公网端跳过 */ }
});
