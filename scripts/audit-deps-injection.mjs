#!/usr/bin/env node
/**
 * audit-deps-injection.mjs —— 注入层脱节审计（发布门禁）。
 *
 * 背景：公司端注入层与共享层脱节是反复出现的事故类型：
 *   1. 硬编码字面量（滚动参数 120s 前追，config.mjs 改了不生效）
 *   2. 占位 stub（shouldFlushTranscriptBuffer 恒 true、correctTranscriptText no-op）
 *   3. 缺失 key（共享模块升级后注入层没跟上）
 *
 * 本脚本做三件事：
 *   A. 从共享模块提取全部 deps.* / deps.config.* 引用
 *   B. 从两端注入块提取实际提供的 key 与形态（常量引用 / 字面量 / 内联函数）
 *   C. 输出：缺失 key、字面量硬编码 key、疑似 stub 注入
 *
 * 用法：node scripts/audit-deps-injection.mjs --company <path> --public <path>
 * 退出码：发现缺失 key 时非零（阻断发布）；硬编码/疑似 stub 仅告警。
 */
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : "";
}

// ---------- 1. 提取共享模块消费的 deps key ----------
function extractDepsUsage(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const configKeys = new Set();
  const fnKeys = new Set();
  for (const match of src.matchAll(/deps\.config\.([A-Z0-9_]+)/g)) configKeys.add(match[1]);
  // deps.xxx( 或 deps.xxx, 形式（排除 deps.config）
  for (const match of src.matchAll(/deps\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
    if (match[1] !== "config") fnKeys.add(match[1]);
  }
  return { configKeys, fnKeys };
}

// ---------- 2. 提取端侧注入块（括号深度感知，支持一行多 key） ----------
function splitTopLevelEntries(block) {
  // block 含首尾 {}，剥离注释与字符串后在深度 1 按逗号切分 entry。
  const entries = [];
  let depth = 0, current = "", i = 0;
  const src = block;
  while (i < src.length) {
    const ch = src[i];
    // 跳过字符串
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      current += ch; i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") { current += src[i] + src[i + 1]; i += 2; continue; }
        current += src[i]; i += 1;
      }
      current += src[i] || ""; i += 1;
      continue;
    }
    // 跳过行注释
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    // 跳过块注释
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if ("{([".includes(ch)) depth += 1;
    if ("})]".includes(ch)) depth -= 1;
    if (ch === "," && depth === 1) {
      if (current.trim()) entries.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (depth >= 1) current += ch;
    i += 1;
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

function classifyEntry(rawEntry) {
  const entry = rawEntry.replace(/^\{/, "").trim();
  const m = entry.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*([\s\S]*))?$/);
  if (!m) return null;
  const [, key, rawValue] = m;
  if (rawValue === undefined) return [key, "shorthand"];
  const value = rawValue.trim();
  if (/^[\d"'`]/.test(value) || /^(true|false|null)\b/.test(value)) return [key, "literal"];
  if (/=>|^async\b|^function\b|^\(\s*\)\s*=>/.test(value)) return [key, "inline-fn"];
  return [key, "constant"];
}

function sliceBlock(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  return "";
}

function extractInjection(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const sessionCall = src.indexOf("createLiveAsrSession(client, clientUrl, {");
  if (sessionCall < 0) return null;
  const openIndex = src.indexOf("{", sessionCall + "createLiveAsrSession(client, clientUrl, ".length);
  const block = sliceBlock(src, openIndex);

  const provided = new Map();
  for (const entry of splitTopLevelEntries(block)) {
    const parsed = classifyEntry(entry);
    if (parsed) provided.set(parsed[0], parsed[1]);
  }

  // config 子块：从块内定位 "config:" 后的第一个 {
  const configKeyIndex = block.search(/\bconfig\s*:/);
  const configProvided = new Map();
  if (configKeyIndex >= 0) {
    const configOpen = block.indexOf("{", configKeyIndex);
    const configBlock = sliceBlock(block, configOpen);
    for (const entry of splitTopLevelEntries(configBlock)) {
      const parsed = classifyEntry(entry);
      if (parsed) configProvided.set(parsed[0], parsed[1]);
    }
  }
  return { provided, configProvided };
}

// ---------- 3. 主流程 ----------
const modules = ["live-asr-session.mjs", "live-asr-helpers.mjs", "tail-stabilization.mjs"];
const usage = { configKeys: new Set(), fnKeys: new Set() };
for (const mod of modules) {
  const file = path.join(rootDir, "modules", mod);
  if (!fs.existsSync(file)) continue;
  const u = extractDepsUsage(file);
  u.configKeys.forEach((k) => usage.configKeys.add(k));
  u.fnKeys.forEach((k) => usage.fnKeys.add(k));
}

const targets = [
  ["company", argValue("--company")],
  ["public", argValue("--public")],
].filter(([, p]) => p);

let missingTotal = 0;
for (const [name, targetDir] of targets) {
  const indexPath = path.join(targetDir, "server", "index.mjs");
  if (!fs.existsSync(indexPath)) { console.log(`[${name}] index.mjs 不存在，跳过`); continue; }
  const injection = extractInjection(indexPath);
  if (!injection) { console.log(`[${name}] 未找到注入块`); missingTotal += 1; continue; }

  const missingConfig = [...usage.configKeys].filter((k) => !injection.configProvided.has(k));
  const missingFns = [...usage.fnKeys].filter((k) => !injection.provided.has(k));
  const literalConfig = [...injection.configProvided.entries()].filter(([, form]) => form === "literal").map(([k]) => k);
  const inlineFns = [...injection.provided.entries()].filter(([, form]) => form === "inline-fn").map(([k]) => k);

  console.log(`\n[${name}] ${indexPath}`);
  console.log(`  共享层消费: ${usage.configKeys.size} config keys, ${usage.fnKeys.size} fn keys`);
  if (missingConfig.length) { console.log(`  ❌ 缺失 config key: ${missingConfig.join(", ")}`); missingTotal += missingConfig.length; }
  if (missingFns.length) { console.log(`  ❌ 缺失 fn key: ${missingFns.join(", ")}`); missingTotal += missingFns.length; }
  if (literalConfig.length) console.log(`  ⚠️  config 字面量硬编码（config.mjs 改动不生效）: ${literalConfig.join(", ")}`);
  if (inlineFns.length) console.log(`  ℹ️  内联函数注入（人工核对是否 stub）: ${inlineFns.join(", ")}`);
  if (!missingConfig.length && !missingFns.length && !literalConfig.length) console.log("  ✓ 注入层完整且无字面量硬编码");
}

console.log(missingTotal ? `\n发现 ${missingTotal} 个缺失 key，阻断发布` : "\n注入审计通过");
process.exit(missingTotal ? 1 : 0);
