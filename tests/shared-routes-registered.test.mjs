// 共享路由真正注册测试：启动服务、请求接口、断言 x-shengji-route-source: core 头。
// 不只查状态码（旧路由也返回同样状态码），必须证明命中共享实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const isPublic = fs.existsSync(path.resolve("server/db.mjs"));
const isCompany = fs.existsSync(path.resolve("server/db/connection.mjs"));
const PORT = 18900 + (isCompany ? 1 : 0);

async function waitReady(port, timeoutMs = 20_000) {
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

test("共享路由真正注册：x-shengji-route-source 头证明命中 core 实现", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shengji-route-verify-"));
  const env = { ...process.env, PORT: String(PORT), NODE_NO_WARNINGS: "1", SHENGJI_ROUTE_SOURCE: "1" };
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
  const child = spawn(process.execPath, ["--env-file=.env", "server/index.mjs"], {
    cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    assert.ok(await waitReady(PORT), "服务未就绪");
    let cookie = "";
    if (isCompany) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/mock-login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "route@ke.com" }),
      });
      cookie = String(r.headers.get("set-cookie") || "").split(";")[0];
    }
    const headers = cookie ? { cookie } : {};
    // 每组共享路由至少一个接口，断言 x-shengji-route-source: core
    const checks = [
      ["GET", "/api/state", "state"],
      ["GET", "/api/meeting-segments?meetingId=1", "extras"],
      ["GET", "/api/meetings/finalization-status?meetingId=1", "finalization"],
      ["PATCH", "/api/speakers/rename", "speaker"],
      ["POST", "/api/glossary", "glossary"],
      ["POST", "/api/meetings", "project-meeting"],
      ["GET", "/api/projects/1/chat/history", "project-context"],
    ];
    for (const [method, path_, group] of checks) {
      const r = await fetch(`http://127.0.0.1:${PORT}${path_}`, { method, headers });
      const source = r.headers.get("x-shengji-route-source");
      assert.equal(source, "core", `${method} ${path_}（${group}）未命中共享路由（x-shengji-route-source=${source}），可能走了端侧旧实现`);
    }
    console.log(`✓ ${isCompany ? "公司端" : "公网端"} 7 组共享路由全部命中 core 实现`);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
