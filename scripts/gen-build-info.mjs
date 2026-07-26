#!/usr/bin/env node
// 构建时生成 build-info.json（commit sha + 构建时间），供 /api/health 溯源。
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

let appCommit = "unknown";
try {
  appCommit = execSync("git rev-parse --short=10 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch { /* 非 git 环境（如 CI 打包后）由 APP_COMMIT 环境变量兜底 */ }

writeFileSync("build-info.json", JSON.stringify({
  appCommit: process.env.APP_COMMIT || appCommit,
  buildTime: new Date().toISOString(),
}, null, 2) + "\n");
console.log(`build-info.json written: ${appCommit}`);
