#!/usr/bin/env node
/**
 * sync-core.mjs —— 从 shengji-core 受控复制共享模块到消费端仓库。
 *
 * 用法：
 *   node scripts/sync-core.mjs --target <consumer-repo-path> --check
 *   node scripts/sync-core.mjs --target <consumer-repo-path> --sync
 *
 * --check: 只校验消费端副本与 core-sync.json 是否一致，不修改文件
 * --sync:  把 core 模块/测试复制到消费端 server/，并写入 core-sync.json
 *
 * 消费端（公网/公司）的 server/ 目录下：
 *   - core 模块直接复制到 server/（import 路径不变）
 *   - core-sync.json 写到消费端根目录（记录当前 core 版本 + 文件哈希）
 *   - adapter 文件（sqlite-/mysql-/config/speaker-store 等）不在 core 中，不受影响
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreRoot = join(__dirname, "..");

function sha256(filePath) {
  return createHash(readFileSync(filePath)).digest("hex");
}

function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function main() {
  const args = process.argv.slice(2);
  const targetIdx = args.indexOf("--target");
  const checkMode = args.includes("--check");
  const syncMode = args.includes("--sync");

  if (targetIdx === -1 || !args[targetIdx + 1]) {
    console.error("用法: node sync-core.mjs --target <consumer-repo-path> --check|--sync");
    process.exit(1);
  }

  const target = resolve(args[targetIdx + 1]);
  if (!existsSync(target)) {
    console.error(`消费端仓库不存在: ${target}`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(join(coreRoot, "core-sync.json"), "utf8"));
  const targetServer = join(target, "server");
  const targetManifestPath = join(target, "core-sync.json");

  if (checkMode) {
    // 校验模式：逐文件比对哈希
    const errors = [];

    for (const m of manifest.modules) {
      const targetFile = join(targetServer, m.file);
      if (!existsSync(targetFile)) {
        errors.push(`MISSING: ${m.file}`);
        continue;
      }
      const actualHash = hashFile(targetFile);
      if (actualHash !== m.sha256) {
        errors.push(`HASH MISMATCH: ${m.file}（期望 ${m.sha256.slice(0, 12)}，实际 ${actualHash.slice(0, 12)}）`);
      }
    }

    // scripts（门禁脚本）同步到消费端 scripts/
    for (const sc of manifest.scripts || []) {
      const targetFile = join(target, "scripts", sc.file);
      if (!existsSync(targetFile)) {
        errors.push(`MISSING: scripts/${sc.file}`);
        continue;
      }
      const actualHash = hashFile(targetFile);
      if (actualHash !== sc.sha256) {
        errors.push(`HASH MISMATCH: scripts/${sc.file}`);
      }
    }

    // policies（白名单/例外清单）同步到消费端根目录
    for (const p of manifest.policies || []) {
      const targetFile = join(target, p.file);
      if (!existsSync(targetFile)) {
        errors.push(`MISSING: ${p.file}`);
        continue;
      }
      const actualHash = hashFile(targetFile);
      if (actualHash !== p.sha256) {
        errors.push(`HASH MISMATCH: ${p.file}`);
      }
    }

    // 校验 core-sync.json 版本
    if (existsSync(targetManifestPath)) {
      const targetManifest = JSON.parse(readFileSync(targetManifestPath, "utf8"));
      if (targetManifest.version !== manifest.version) {
        errors.push(`VERSION MISMATCH: 消费端 ${targetManifest.version} != core ${manifest.version}`);
      }
    } else {
      errors.push("MISSING: core-sync.json（消费端未执行过 sync-core --sync）");
    }

    if (errors.length > 0) {
      console.error(`❌ core-sync 校验失败（v${manifest.version}）：`);
      for (const err of errors) {
        console.error(`  ${err}`);
      }
      console.error(`\n请在 shengji-core 中修改后运行: node scripts/sync-core.mjs --target ${target} --sync`);
      process.exit(1);
    }

    console.log(`✓ core-sync 校验通过：v${manifest.version}，${manifest.modules.length} 模块 + ${manifest.tests.length} 测试哈希一致`);
    return;
  }

  if (syncMode) {
    // 同步模式：复制模块和测试到消费端
    let copied = 0;

    for (const m of manifest.modules) {
      const src = join(coreRoot, "modules", m.file);
      const dst = join(targetServer, m.file);
      copyFileSync(src, dst);
      copied++;
    }

    // 测试文件也复制到 server/
    for (const t of manifest.tests) {
      const src = join(coreRoot, "tests", t.file);
      const dst = join(targetServer, t.file);
      copyFileSync(src, dst);
      copied++;
    }

    // scripts（门禁脚本）复制到消费端 scripts/
    for (const sc of manifest.scripts || []) {
      copyFileSync(join(coreRoot, "scripts", sc.file), join(target, "scripts", sc.file));
      copied++;
    }

    // policies（白名单/例外清单）复制到消费端根目录
    for (const p of manifest.policies || []) {
      copyFileSync(join(coreRoot, p.file), join(target, p.file));
      copied++;
    }

    // 写 core-sync.json 到消费端
    writeFileSync(targetManifestPath, JSON.stringify(manifest, null, 2) + "\n");

    console.log(`✓ core-sync 同步完成：v${manifest.version}，复制 ${copied} 文件到 ${target}`);
    console.log(`  core-sync.json 已写入消费端根目录`);
    return;
  }

  console.error("请指定 --check 或 --sync");
  process.exit(1);
}

main();
