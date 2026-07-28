#!/usr/bin/env node
// 构建时生成 build-info.json（commit sha + 构建时间 + core/frontend 版本），供 /api/health 溯源。
// 必须在 git pull 后、服务重启前跑——否则 health 显示旧 commit（过期部署元数据）。
// 基于脚本自身位置定位项目根，不依赖调用目录（cd server 后也能正确写到项目根）。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");  // 项目根（scripts/ 的上一级）

let appCommit = "unknown";
try {
  appCommit = execSync("git rev-parse --short=10 HEAD", { stdio: ["ignore", "pipe", "ignore"], cwd: rootDir }).toString().trim();
} catch { /* 非 git 环境（如 CI 打包后）由 APP_COMMIT 环境变量兜底 */ }

// core/frontend 版本从 sync 文件读（基于项目根定位，不依赖调用目录）。
let coreVersion = "";
let frontendRevision = "";
try {
  const coreSyncPath = resolve(rootDir, "core-sync.json");
  if (existsSync(coreSyncPath)) {
    coreVersion = JSON.parse(readFileSync(coreSyncPath, "utf8")).version || "";
  }
} catch { /* ignore */ }
try {
  const frontendSyncPath = resolve(rootDir, "frontend-sync.json");
  if (existsSync(frontendSyncPath)) {
    frontendRevision = JSON.parse(readFileSync(frontendSyncPath, "utf8")).revision || "";
  }
} catch { /* ignore */ }

// 写到项目根 build-info.json（不依赖当前工作目录）。
writeFileSync(resolve(rootDir, "build-info.json"), JSON.stringify({
  appCommit: process.env.APP_COMMIT || appCommit,
  buildTime: new Date().toISOString(),
  coreVersion,
  frontendRevision,
}, null, 2) + "\n");
console.log(`build-info.json written: ${appCommit} core=${coreVersion} frontend=${frontendRevision.slice(0, 12)}`);
