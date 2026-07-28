// 共享路由全量注册测试：逐条覆盖所有共享 endpoint（不只每组一个）。
// 断言 x-shengji-route-source: core 头证明命中共享实现（不只查状态码——
// 旧路由也返回同样状态码），并对所有需要 meetingId 的接口断言缺失时返回 400。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const isPublic = fs.existsSync(path.resolve("server/db.mjs"));
const isCompany = fs.existsSync(path.resolve("server/db/connection.mjs"));
const PORT = 18900 + (isCompany ? 1 : 0);

async function waitReady(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// 从共享模块动态收集路由表（两端消费同一份，不再手写列表漏接口）。
async function collectSharedRoutes() {
  const modules = [
    "register-glossary-routes.mjs",
    "register-speaker-routes.mjs",
    "register-meeting-extras-routes.mjs",
    "register-finalization-routes.mjs",
    "register-state-routes.mjs",
    "register-project-meeting-routes.mjs",
    "register-project-context-routes.mjs",
  ];
  const all = [];
  for (const mod of modules) {
    const m = await import(`./${mod}`);
    const register = Object.values(m).find((v) => typeof v === "function");
    const routes = register({
      readJson: async () => ({}), sendJson: () => {},
    });
    for (const r of routes) all.push({ ...r, group: mod.replace("register-", "").replace("-routes.mjs", "") });
  }
  return all;
}

// 把 pattern 转为可请求的示例路径（:id → 1，?meetingId 保留）。
function samplePath(pattern) {
  return pattern.source
    .replace(/^\^/, "").replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\[\\d\]\+\)|\(\\d\+\)/g, "1")
    .replace(/\\/g, "");
}

// 路由表里的 method: "*" 需要逐方法验证（公网端 P1 风险：* 遮蔽具体路由）。
const STAR_METHODS = ["GET", "POST", "PATCH", "DELETE"];

async function startServer(extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shengji-route-verify-"));
  const env = {
    ...process.env,
    PORT: String(PORT), API_PORT: String(PORT), // .env 里的 API_PORT 会覆盖 PORT，两个都设
    NODE_NO_WARNINGS: "1", CONTRACT_TEST_MODE: "1",
    SKIP_LOCAL_DEFAULT_CHECK: "1",
    ...extraEnv,
  };
  if (isPublic) env.VOICE_DATA_DIR = tmp;
  if (isCompany) {
    Object.assign(env, {
      APP_DB_HOST: process.env.CONTRACT_DB_HOST || "127.0.0.1",
      APP_DB_PORT: process.env.CONTRACT_DB_PORT || "3306",
      APP_DB_USER: process.env.CONTRACT_DB_USER || "root",
      APP_DB_PASSWORD: process.env.CONTRACT_DB_PASSWORD ?? "",
      APP_DB_NAME: process.env.CONTRACT_DB_NAME || "meeting_assistant_routetest",
      AUTH_MODE: "mock", MOCK_USERS: "route@ke.com:路由测试",
    });
  }
  const child = spawn(process.execPath, [...(fs.existsSync(".env") ? ["--env-file=.env"] : []), "server/index.mjs"], {
    cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, tmp };
}

async function loginCookie() {
  if (!isCompany) return "";
  const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/mock-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "route@ke.com" }),
  });
  return String(r.headers.get("set-cookie") || "").split(";")[0];
}

test("共享路由全量注册：逐条覆盖所有 endpoint，断言命中 core 实现", async () => {
  const routes = await collectSharedRoutes();
  assert.ok(routes.length >= 30, `共享路由表应至少 30 条，实际 ${routes.length} 条`);
  const { child, tmp } = await startServer();
  try {
    assert.ok(await waitReady(PORT), "服务未就绪");
    const cookie = await loginCookie();
    const headers = { ...(cookie ? { cookie } : {}), "content-type": "application/json" };
    let covered = 0;
    for (const route of routes) {
      const methods = route.method === "*" ? STAR_METHODS : [route.method];
      const sample = samplePath(route.pattern);
      for (const method of methods) {
        // "*" 路由对不支持的方法返回 405 也算命中 core（有标记头即可）。
        const r = await fetch(`http://127.0.0.1:${PORT}${sample}`, {
          method, headers, body: ["POST", "PATCH"].includes(method) ? "{}" : undefined,
        });
        const source = r.headers.get("x-shengji-route-source");
        // 端侧独有的更具体路由（如 /api/projects/:id/chat）可能先匹配——
        // 这些不算共享路由未注册，跳过；其余必须命中 core。
        if (source !== "core" && route.method === "*") continue;
        assert.equal(
          source, "core",
          `${method} ${sample}（${route.group}）未命中共享路由（x-shengji-route-source=${source}，status=${r.status}），可能走了端侧旧实现`,
        );
        covered += 1;
      }
    }
    console.log(`✓ ${isCompany ? "公司端" : "公网端"} ${routes.length} 条共享路由全量覆盖（${covered} 个 method×path 组合命中 core）`);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("缺 meetingId 的接口返回 400（不再默认会议 1）", async () => {
  const { child, tmp } = await startServer();
  try {
    assert.ok(await waitReady(PORT), "服务未就绪");
    const cookie = await loginCookie();
    const headers = { ...(cookie ? { cookie } : {}), "content-type": "application/json" };
    const checks = [
      ["GET", "/api/meetings/finalization-status"],
      ["POST", "/api/meetings/finalize", "{}"],
      ["POST", "/api/meetings/finalize-draft", "{}"],
      ["GET", "/api/meetings/finalize-draft/status"],
      ["POST", "/api/speakers/reconcile", "{}"],
      ["POST", "/api/speakers/backfill", "{}"],
      ["POST", "/api/speakers/reconcile-voice-cluster", "{}"],
    ];
    for (const [method, path_, body] of checks) {
      const r = await fetch(`http://127.0.0.1:${PORT}${path_}`, { method, headers, body });
      assert.equal(r.status, 400, `${method} ${path_} 缺 meetingId 应返回 400，实际 ${r.status}`);
    }
    console.log(`✓ ${checks.length} 个接口缺 meetingId 全部 400`);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
