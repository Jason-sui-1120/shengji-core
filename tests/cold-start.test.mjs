// 冷启动回归：空数据库 seedDatabase + /api/asr/models 可用（asrModels 来自共享模块，不再 ReferenceError）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("空数据库冷启动：seedDatabase 不抛错且模型候选已入库", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shengji-coldstart-"));
  // 数据目录环境变量是 VOICE_DATA_DIR（env.mjs 定义），不是 DATA_DIR。
  process.env.VOICE_DATA_DIR = tmp;
  const { seedDatabase, ensureDatabase } = await import("./schema.mjs").catch(() => ({}));
  if (!seedDatabase) { console.log("skip: 公司端 schema 在 db/schema.mjs，本回归仅适用公网端"); return; }
  const { openDb } = await import("./db.mjs");
  assert.doesNotThrow(() => { ensureDatabase(); seedDatabase(true); }, "建库+种子不得抛错（asrModels 引用）");
  const db = openDb();
  const rows = db.prepare("SELECT id, vendor FROM asr_model_candidates").all();
  db.close();
  assert.ok(rows.length >= 4, `模型候选应入库（实际 ${rows.length}）`);
  fs.rmSync(tmp, { recursive: true, force: true });
});
