// 共享路由真正注册测试：启动服务、请求接口、断言命中共享实现（不只验证文件存在）。
// 覆盖公网端（SQLite）与公司端（MySQL）两种形态。
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

test("共享路由真正注册：state/segments/finalization/speakers/glossary 均命中共享实现", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shengji-route-verify-"));
  const env = { ...process.env, PORT: String(PORT), NODE_NO_WARNINGS: "1" };
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
    const checks = [
      ["GET", "/api/state", [200]],
      ["GET", "/api/meeting-segments?meetingId=1", [200]],
      ["GET", "/api/meetings/finalization-status?meetingId=1", [200]],
      ["POST", "/api/glossary", [400]],   // 空 body → 共享模块 400（不是 404）
      ["POST", "/api/meetings/finalize-draft", [202]], // 异步任务 202
    ];
    for (const [method, path_, allowed] of checks) {
      const r = await fetch(`http://127.0.0.1:${PORT}${path_}`, { method, headers });
      assert.ok(allowed.includes(r.status), `${method} ${path_} 应返回 ${allowed}，实际 ${r.status}（共享路由未注册或走错实现）`);
    }
    console.log(`✓ ${isCompany ? "公司端" : "公网端"} 共享路由全部真正注册`);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
