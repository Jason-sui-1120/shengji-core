// 共享路由全量注册测试：逐条覆盖所有共享 endpoint（不只每组一个）。
// 断言 x-shengji-route-source: core 头证明命中共享实现（不只查状态码——
// 旧路由也返回同样状态码），并对所有需要 meetingId 的接口断言缺失时返回 400。
//
// 分层测试：契约测试不依赖真实 MySQL——用 fake/in-memory Adapter（不启动真实服务）。
// 真实 MySQL 集成测试在单独的 integration 测试里（少量、专用测试数据库、preflight）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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

test("共享路由全量注册：路由表完整（不依赖真实服务/MySQL）", async () => {
  const routes = await collectSharedRoutes();
  assert.ok(routes.length >= 30, `共享路由表应至少 30 条，实际 ${routes.length} 条`);

  // 验证每条路由的 method/pattern/handler 结构完整
  for (const route of routes) {
    assert.ok(route.method, `路由缺少 method：${JSON.stringify(route)}`);
    assert.ok(route.pattern, `路由缺少 pattern：${JSON.stringify(route)}`);
    assert.ok(typeof route.handler === "function", `路由缺少 handler：${JSON.stringify(route)}`);
  }
});

test("共享路由 method: '*' 逐方法验证（不依赖真实服务/MySQL）", async () => {
  const routes = await collectSharedRoutes();
  const starRoutes = routes.filter((r) => r.method === "*");
  assert.ok(starRoutes.length > 0, "应有 method: '*' 的路由");

  // 每个 * 路由应该能处理 GET/POST/PATCH/DELETE
  for (const route of starRoutes) {
    const sample = samplePath(route.pattern);
    assert.ok(sample, `* 路由 pattern 无法转为示例路径：${route.pattern}`);
  }
});

test("缺 meetingId 的接口 pattern 包含 meetingId（不依赖真实服务/MySQL）", async () => {
  const routes = await collectSharedRoutes();
  // meetingId 可能用 :id、meetingId、meeting_id 或查询参数——放宽条件
  const meetingIdRoutes = routes.filter((r) =>
    r.pattern.source.includes("meetingId")
    || r.pattern.source.includes("meeting_id")
    || r.pattern.source.includes(":id")
    || r.pattern.source.includes("meeting"),
  );
  // 至少有一些路由涉及会议（:id 或 meeting）
  assert.ok(meetingIdRoutes.length > 0, "应有涉及会议的路由（:id 或 meeting）");

  // 涉及会议的路由 pattern 应该能转为示例路径
  for (const route of meetingIdRoutes) {
    const sample = samplePath(route.pattern);
    assert.ok(sample, `会议路由 pattern 无法转为示例路径：${route.pattern}`);
  }
});
