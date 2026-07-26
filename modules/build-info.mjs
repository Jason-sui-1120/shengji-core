/**
 * build-info.mjs —— 构建信息（构建时由构建脚本生成 build-info.json，运行时读取）。
 * 两端 /api/health 统一返回版本溯源字段。
 */
import fs from "node:fs";
import path from "node:path";
import { rootDir } from "./env.mjs";

let cached = null;

export function getBuildInfo() {
  if (cached) return cached;
  let info = {};
  // 构建产物从 dist/server 启动时向上查找（与 config.json/models.json 同一策略）。
  let dir = rootDir;
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, "build-info.json");
    if (fs.existsSync(candidate)) {
      try { info = JSON.parse(fs.readFileSync(candidate, "utf8")); } catch { /* ignore */ }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = {
    appCommit: String(info.appCommit || process.env.APP_COMMIT || "unknown"),
    buildTime: String(info.buildTime || process.env.BUILD_TIME || ""),
  };
  return cached;
}
