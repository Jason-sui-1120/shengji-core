/**
 * build-info.mjs —— 构建信息（构建时由构建脚本生成 build-info.json，运行时读取）。
 * 两端 /api/health 统一返回版本溯源字段。
 * 不缓存：部署脚本在服务启动后才写入 build-info.json，缓存会导致永远读不到新值。
 */
import fs from "node:fs";
import path from "node:path";
import { rootDir } from "./env.mjs";

export function getBuildInfo() {
  let info = {};
  // 构建产物从 dist/server 启动时向上查找（与 config.json/models.json 同一策略）。
  // 同时查 server/build-info.json（部署工作流注入位置）。
  let dir = rootDir;
  for (let depth = 0; depth < 5; depth += 1) {
    for (const candidate of [path.join(dir, "build-info.json"), path.join(dir, "server", "build-info.json")]) {
      if (fs.existsSync(candidate)) {
        try { info = JSON.parse(fs.readFileSync(candidate, "utf8")); } catch { /* ignore */ }
        break;
      }
    }
    if (Object.keys(info).length) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    appCommit: String(info.appCommit || process.env.APP_COMMIT || "unknown"),
    buildTime: String(info.buildTime || process.env.BUILD_TIME || ""),
    coreVersion: String(info.coreVersion || process.env.CORE_VERSION || ""),
    frontendRevision: String(info.frontendRevision || process.env.FRONTEND_REVISION || ""),
  };
}
