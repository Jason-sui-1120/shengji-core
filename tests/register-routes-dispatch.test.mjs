// P1-D 注册测试全量覆盖：每个 core register 模块的路由都能被 trySharedRoutes 正确分发
// 验证：pattern 匹配 → handler 被调用 → 返回 true（不只验证结构，验证真实分发行为）
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { trySharedRoutes } from "./try-shared-routes.mjs";

const MODULES = [
  "register-glossary-routes.mjs",
  "register-speaker-routes.mjs",
  "register-meeting-extras-routes.mjs",
  "register-finalization-routes.mjs",
  "register-state-routes.mjs",
  "register-project-meeting-routes.mjs",
  "register-project-context-routes.mjs",
];

// 收集每个模块的路由（用 stub deps，handler 替换为记录调用的 spy）
async function collectWithSpy() {
  const result = [];
  for (const mod of MODULES) {
    const m = await import(`./${mod}`);
    const register = Object.values(m).find((v) => typeof v === "function");
    const routes = register({
      readJson: async () => ({}),
      sendJson: () => {},
      getAuthContext: () => ({}),
      canAccess: async () => true,
      ...Object.fromEntries(
        ["renameSpeaker","deleteSpeaker","reconcileSpeakers","backfillSpeakers","reconcileByVoiceCluster",
         "upsertGlossaryEntry","deleteGlossaryEntry","correctBatchGlossary","getState","searchTranscripts",
         "insertTranscript","updateTranscript","listMeetingSegments","replaceSummaryBlock","insertAction",
         "updateAction","softDeleteAction","restoreAction","getFinalizationGate","saveFinalizedDraft",
         "finalizeMeeting","startFinalizeDraftJob","getFinalizeDraftJobStatus","createMeeting","createProject",
         "updateProjectMemory","chatWithProject","getProjectChatHistory","createActionFromChat",
         "markProjectChatMemorySaved","listProjects","listMeetings","getMeeting","updateMeeting","deleteMeeting",
         "getProject","updateProject","deleteProject"].map(k => [k, async () => ({})])
      ),
    });
    for (const r of routes) {
      const calls = []; // 每个路由独立的调用记录
      const spy = async () => { calls.push(r.pattern.source); };
      result.push({ group: mod, method: r.method, pattern: r.pattern, handler: spy, calls });
    }
  }
  return result;
}

function samplePath(pattern) {
  return pattern.source
    .replace(/^\^/, "").replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\[\\d\]\+\)|\(\\d\+\)/g, "1")
    .replace(/\(\[\^\/\]\+\)/g, "x")
    .replace(/\\/g, "");
}

function mockReq(method) {
  return { method, headers: {}, on: () => {}, };
}
function mockRes() {
  return { writeHead: () => {}, end: () => {}, setHeader: () => {} };
}

describe("P1-D: 每个 register 模块路由分发", () => {
  test("所有模块路由都能被 trySharedRoutes 命中并调用 handler", async () => {
    const routes = await collectWithSpy();
    assert.ok(routes.length >= 30, `应至少 30 条路由，实际 ${routes.length}`);

    let dispatched = 0;
    const failures = [];
    for (const r of routes) {
      const path = samplePath(r.pattern);
      if (!path || path.includes("(")) { failures.push(`${r.group} pattern 无法转示例: ${r.pattern.source}`); continue; }
      const method = r.method === "*" ? "GET" : r.method;
      const url = new URL("http://localhost" + path);
      const handled = await trySharedRoutes([r], mockReq(method), mockRes(), url);
      if (handled && r.calls.length === 1) dispatched++;
      else failures.push(`${r.group} ${method} ${path} 未分发 (handled=${handled}, calls=${r.calls.length})`);
    }
    assert.equal(failures.length, 0, `分发失败:\n${failures.join("\n")}`);
    assert.ok(dispatched >= 30, `应至少分发 30 条，实际 ${dispatched}`);
  });

  test("method 不匹配时不分发", async () => {
    const routes = await collectWithSpy();
    const getRoute = routes.find((r) => r.method === "POST");
    if (!getRoute) return;
    const path = samplePath(getRoute.pattern);
    const url = new URL("http://localhost" + path);
    const handled = await trySharedRoutes([getRoute], mockReq("GET"), mockRes(), url);
    assert.equal(handled, false, "method 不匹配不应分发");
    assert.equal(getRoute.calls.length, 0, "handler 不应被调用");
  });

  test("pattern 不匹配时返回 false", async () => {
    const routes = await collectWithSpy();
    const url = new URL("http://localhost/api/nonexistent-path-xyz");
    const handled = await trySharedRoutes(routes, mockReq("GET"), mockRes(), url);
    assert.equal(handled, false, "无匹配 pattern 应返回 false");
  });

  test("7 个 register 模块全部有路由注册", async () => {
    const routes = await collectWithSpy();
    const groups = new Set(routes.map((r) => r.group));
    for (const mod of MODULES) {
      assert.ok(groups.has(mod), `模块 ${mod} 未注册任何路由`);
    }
    assert.equal(groups.size, MODULES.length, `应有 ${MODULES.length} 个模块，实际 ${groups.size}`);
  });
});
