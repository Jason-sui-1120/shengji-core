#!/usr/bin/env node
/**
 * verify-api-contract.mjs —— 真实双端 API 契约测试（收口任务 7）。
 *
 * 真实启动两端测试服务，用同一组请求比对共同 API：
 *   - 存在性（路由不 404 到未知 handler）
 *   - 状态码在契约允许集合内
 *   - 响应必填字段存在且类型正确
 *   - 差异只允许 api-profile-exceptions.json 登记项
 *
 * 用法：
 *   node scripts/verify-api-contract.mjs --company <path> --public <path>
 *   node scripts/verify-api-contract.mjs --public <path>   # 单端
 *
 * 退出码：任一共同 API 缺失/结构漂移 → 1（阻断）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const contract = JSON.parse(fs.readFileSync(path.join(rootDir, "api-contract.json"), "utf8"));
const exceptions = JSON.parse(fs.readFileSync(path.join(rootDir, "api-profile-exceptions.json"), "utf8"));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : "";
}

const PORT_BASE = 18700;

function startServer(side, dir, port) {
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_NO_WARNINGS: "1",
  };
  if (side === "company") {
    Object.assign(env, {
      APP_DB_HOST: process.env.CONTRACT_DB_HOST || "127.0.0.1",
      APP_DB_PORT: process.env.CONTRACT_DB_PORT || "3306",
      APP_DB_USER: process.env.CONTRACT_DB_USER || "root",
      APP_DB_PASSWORD: process.env.CONTRACT_DB_PASSWORD ?? "",
      APP_DB_NAME: process.env.CONTRACT_DB_NAME || "meeting_assistant_contract",
      AUTH_MODE: "mock",
      MOCK_USERS: "contract@ke.com:契约测试",
      ADMIN_EMAILS: "contract@ke.com",
    });
  }
  const child = spawn(process.execPath, [...(fs.existsSync(".env") ? ["--env-file=.env"] : []), "server/index.mjs"], {
    cwd: dir, env, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[${side}] ${d}`));
  return child;
}

async function waitReady(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function callApi(port, api, cookie) {
  const url = `http://127.0.0.1:${port}${api.path}`;
  const headers = { ...(cookie ? { cookie } : {}), ...(api.body ? { "content-type": "application/json" } : {}) };
  const r = await fetch(url, {
    method: api.method, headers,
    body: api.body ? JSON.stringify(api.body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body };
}

function checkFields(body, requiredFields) {
  const errors = [];
  for (const [field, type] of Object.entries(requiredFields || {})) {
    if (!(field in (body || {}))) { errors.push(`缺字段 ${field}`); continue; }
    const value = body[field];
    const ok = type === "array" ? Array.isArray(value)
      : type === "object" ? (value !== null && typeof value === "object" && !Array.isArray(value))
      : typeof value === type;
    if (!ok) errors.push(`字段 ${field} 类型错误（期望 ${type}，实际 ${Array.isArray(value) ? "array" : typeof value}）`);
  }
  return errors;
}

function isExcepted(side, api) {
  return (exceptions.exceptions || []).some((e) => {
    if (e.method !== "*" && e.method !== api.method) return false;
    const pattern = e.path.replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*");
    if (!new RegExp(`^${pattern}$`).test(api.path.split("?")[0])) return false;
    return e.availableIn === "both" || e.availableIn === side;
  });
}

async function main() {
  const targets = [
    ["company", argValue("--company")],
    ["public", argValue("--public")],
  ].filter(([, p]) => p);
  if (!targets.length) { console.error("需要 --company 或 --public"); process.exit(2); }

  let failed = 0;
  let port = PORT_BASE;
  const children = [];
  try {
    for (const [side, dir] of targets) {
      port += 1;
      console.log(`\n[${side}] 启动测试服务 :${port} (${dir})`);
      const child = startServer(side, dir, port);
      children.push(child);
      if (!await waitReady(port)) {
        console.error(`  ❌ 服务未就绪`);
        failed += 1;
        continue;
      }
      // 公司端 mock 登录拿 cookie
      let cookie = "";
      if (side === "company") {
        const r = await fetch(`http://127.0.0.1:${port}/api/auth/mock-login`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "contract@ke.com" }),
        });
        cookie = String(r.headers.get("set-cookie") || "").split(";")[0];
      }
      for (const api of contract.apis) {
        if (isExcepted(side, api)) { console.log(`  ⏭  ${api.method} ${api.path}（例外清单豁免）`); continue; }
        // 用例隔离：DELETE/restore 类用例前先确保 fixture 数据存在（避免前序用例污染）
        if (api.path.match(/^\/api\/(actions|transcripts)\/\d+/)) {
          await callApi(port, { method: "POST", path: "/api/actions", body: { meetingId: 1, title: "fixture", owner: "fixture" }, status: [200, 201] }, cookie).catch(() => {});
        }
        const { status, body } = await callApi(port, api, cookie);
        const allowed = Array.isArray(api.status) ? api.status : [api.status];
        const errors = [];
        if (!allowed.includes(status)) errors.push(`状态码 ${status} 不在契约 [${allowed}]`);
        if (status === 200) errors.push(...checkFields(body, api.requiredFields));
        if (errors.length) {
          console.log(`  ❌ ${api.method} ${api.path}: ${errors.join("；")}`);
          failed += 1;
        } else {
          console.log(`  ✓ ${api.method} ${api.path} → ${status}`);
        }
      }
    }
  } finally {
    children.forEach((c) => { try { c.kill("SIGTERM"); } catch { /* gone */ } });
  }
  console.log(failed ? `\n❌ ${failed} 项契约违规` : "\n✓ 双端 API 契约全部通过");
  process.exit(failed ? 1 : 0);
}

await main();
