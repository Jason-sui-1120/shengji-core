#!/usr/bin/env node
/**
 * verify-adapter-contract.mjs —— Adapter 契约测试（收口任务 4）。
 *
 * 校验两端 server/index.mjs 暴露的 Adapter 函数集覆盖 adapter-contract.json
 * 定义的方法清单。通过静态分析 index.mjs 中"函数定义 + 注入对象"判断实现存在性。
 * 缺失即 CI 失败（exit 1）。
 *
 * 用法：node scripts/verify-adapter-contract.mjs --company <path> --public <path>
 */
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const contract = JSON.parse(fs.readFileSync(path.join(rootDir, "adapter-contract.json"), "utf8"));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : "";
}

// 收集 index.mjs 中可调用的符号：函数定义、import、const 箭头函数、注入 key
function collectSymbols(indexPath) {
  const src = fs.readFileSync(indexPath, "utf8");
  const symbols = new Set();
  for (const m of src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) symbols.add(m[1]);
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g)) symbols.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}/g)) {
    m[1].split(",").forEach((x) => { const name = x.trim().split(" as ").pop().trim(); if (name) symbols.add(name); });
  }
  // adapter 包装（key: (...) => someCall(...)）中的目标函数也视为可用符号
  for (const m of src.matchAll(/=>\s*([A-Za-z_$][\w$]*)\s*\(/g)) symbols.add(m[1]);
  return symbols;
}

// 在 server/ 目录递归找符号定义（db/*.mjs、各 helper 模块）
function collectServerSymbols(dir) {
  const symbols = new Set();
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && !["node_modules", "dist"].includes(e.name)) walk(full);
      else if (e.name.endsWith(".mjs") && !e.name.endsWith(".test.mjs")) files.push(full);
    }
  })(dir);
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) symbols.add(m[1]);
    for (const m of src.matchAll(/export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/g)) symbols.add(m[1]);
  }
  return symbols;
}

const targets = [["company", argValue("--company")], ["public", argValue("--public")]].filter(([, p]) => p);
if (!targets.length) { console.error("需要 --company 或 --public"); process.exit(2); }

let failed = 0;
for (const [side, dir] of targets) {
  const indexPath = path.join(dir, "server", "index.mjs");
  const indexSymbols = collectSymbols(indexPath);
  const serverSymbols = collectServerSymbols(path.join(dir, "server"));
  const available = new Set([...indexSymbols, ...serverSymbols]);

  console.log(`\n[${side}] Adapter 契约校验（index ${indexSymbols.size} + server ${serverSymbols.size} 符号）`);
  for (const [group, spec] of Object.entries(contract.groups)) {
    const missing = spec.methods.filter((m) => !available.has(m));
    if (missing.length) {
      console.log(`  ❌ ${group}: 缺 ${missing.join(", ")}`);
      failed += missing.length;
    } else {
      console.log(`  ✓ ${group}（${spec.methods.length} 方法）`);
    }
  }
}
console.log(failed ? `\n❌ ${failed} 个 Adapter 方法缺失` : "\n✓ 两端 Adapter 契约全部覆盖");
process.exit(failed ? 1 : 0);
