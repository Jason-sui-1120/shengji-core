// Adapter 运行时契约测试：用测试 Adapter 注入共享路由，校验调用参数、返回结构、异常语义。
// 不只是"函数名存在"，而是"注入后行为正确"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerGlossaryRoutes } from "../modules/register-glossary-routes.mjs";
import { registerStateRoutes } from "../modules/register-state-routes.mjs";
import { registerProjectMeetingRoutes } from "../modules/register-project-meeting-routes.mjs";
import { trySharedRoutes } from "../modules/try-shared-routes.mjs";

// 最小 HTTP 模拟：构造 req/res/url，捕获 sendJson 输出
function mockReqRes(method, pathname, body = null) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, url: pathname, headers: {}, on() {}, [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); } };
  let captured = null;
  const res = {
    writeHead(status, headers) { this._status = status; this._headers = headers; },
    end(payload) { captured = { status: this._status, body: payload ? JSON.parse(payload) : null }; },
  };
  return { req, res, url, getResult: () => captured };
}

function mockDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    readJson: async (req) => { let data = ""; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; },
    sendJson: (res, status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); },
    getAuthContext: () => ({ userId: 1, isAdmin: false }),
    ...overrides,
  };
}

test("glossary 路由：注入正确实现时调用参数与返回结构正确", async () => {
  const calls = [];
  const deps = mockDeps({
    upsertGlossaryEntry: async (body, auth) => { calls.push({ method: "upsert", body, auth }); },
    deleteGlossaryEntry: async (id, auth) => { calls.push({ method: "delete", id, auth }); },
    correctBatchGlossary: async (body, auth) => { calls.push({ method: "correctBatch", body, auth }); return { ok: true, applied: 2 }; },
    getState: async (auth) => ({ glossaryEntries: [{ id: 1, term: "声纪" }] }),
  });
  const routes = registerGlossaryRoutes(deps);

  // POST /api/glossary 正常链路
  const { req, res, url, getResult } = mockReqRes("POST", "/api/glossary", { term: "声纪", aliases: ["声迹"] });
  assert.ok(await trySharedRoutes(routes, req, res, url), "应命中共享路由");
  const result = getResult();
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.glossaryEntries), "返回应含 glossaryEntries 数组");
  assert.equal(calls[0].method, "upsert");
  assert.equal(calls[0].body.term, "声纪", "注入的实现收到了正确的 body");
  assert.equal(calls[0].auth.userId, 1, "注入的实现收到了 authContext");

  // 空 term → 400（共享模块的校验，不是 adapter 的）
  const { req: req2, res: res2, url: url2, getResult: getResult2 } = mockReqRes("POST", "/api/glossary", {});
  await trySharedRoutes(routes, req2, res2, url2);
  assert.equal(getResult2().status, 400, "空 term 应 400（共享模块校验）");
});

test("state 路由：注入 getState 时返回结构透传", async () => {
  const deps = mockDeps({
    getState: async (auth) => ({ projects: [{ id: 1 }], meeting: { id: 1 }, transcripts: [], summaryBlocks: [], actions: [] }),
    searchTranscripts: async (q, p, auth) => ({ results: [] }),
    insertTranscript: async (body, auth) => ({ id: 1, ...body }),
    updateTranscript: async (id, body, auth) => ({ id, ...body }),
  });
  const routes = registerStateRoutes(deps);
  const { req, res, url, getResult } = mockReqRes("GET", "/api/state");
  await trySharedRoutes(routes, req, res, url);
  const result = getResult();
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.projects), "state 应含 projects 数组");
  assert.ok(result.body.meeting && typeof result.body.meeting === "object", "state 应含 meeting 对象");
});

test("project/meeting 路由：权限拒绝时 adapter 抛错、共享路由不吞异常", async () => {
  const deps = mockDeps({
    createMeeting: async (body, auth) => { throw new Error("无权限创建会议"); },
    createProject: async (body, auth) => ({ ok: true, project: { id: 1 } }),
    getTrash: async (auth) => ({ projects: [], meetings: [], actions: [] }),
    softDeleteProject: async (id, auth) => ({ ok: true }),
    restoreProject: async (id, auth) => ({ ok: true }),
    purgeProject: async (id, auth) => ({ ok: true }),
    softDeleteMeeting: async (id, auth) => ({ ok: true }),
    restoreMeeting: async (id, auth) => ({ ok: true }),
    purgeMeeting: async (id, auth) => ({ ok: true }),
    purgeAction: async (id, auth) => ({ ok: true }),
  });
  const routes = registerProjectMeetingRoutes(deps);
  // adapter 抛错 → 共享路由不吞（异常冒泡给端侧错误处理）
  const { req, res, url } = mockReqRes("POST", "/api/meetings", { projectId: 1, title: "测试" });
  await assert.rejects(() => trySharedRoutes(routes, req, res, url), /无权限创建会议/, "adapter 权限拒绝应冒泡，不被共享路由吞掉");
});
