/**
 * register-glossary-routes.mjs —— 共享术语表路由装配（唯一来源）。
 *
 * 两端 index.mjs 不再各自实现 glossary 业务流程，统一调用本模块注册。
 * 只依赖注入的 deps，不直接引用 SQLite/MySQL/CAS/Gateway。
 *
 * deps 约定：
 *   readJson(req)                          → Promise<body>
 *   sendJson(res, status, payload)         → void
 *   upsertGlossaryEntry(body, authContext) → Promise<void>  （端侧含权限校验）
 *   deleteGlossaryEntry(id, authContext)   → Promise<void>
 *   correctBatchGlossary(body, authContext)→ Promise<result>
 *   getState(authContext)                  → Promise<state>  （路由响应体）
 *   getAuthContext(req)                    → authContext     （公网 {}，公司端 currentUser）
 */
export function registerGlossaryRoutes(deps) {
  const { readJson, sendJson, upsertGlossaryEntry, deleteGlossaryEntry, correctBatchGlossary, getState, getAuthContext } = deps;

  // 返回 { method, match(url) → params|null, handler } 形式的路由表，
  // 端侧在自己的 HTTP 分发循环里按顺序尝试。
  return [
    {
      method: "POST",
      pattern: /^\/api\/glossary$/,
      async handler(req, res) {
        const body = await readJson(req);
        if (!String(body.term || "").trim()) { sendJson(res, 400, { error: "glossary term required" }); return; }
        await upsertGlossaryEntry(body, getAuthContext(req));
        sendJson(res, 200, await getState(getAuthContext(req)));
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/glossary\/(\d+)$/,
      async handler(req, res, params) {
        const body = await readJson(req);
        await upsertGlossaryEntry({ ...body, id: Number(params[1]) }, getAuthContext(req));
        sendJson(res, 200, await getState(getAuthContext(req)));
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/glossary\/(\d+)$/,
      async handler(req, res, params) {
        await deleteGlossaryEntry(Number(params[1]), getAuthContext(req));
        sendJson(res, 200, await getState(getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/glossary\/correct-batch$/,
      async handler(req, res) {
        const body = await readJson(req);
        const result = await correctBatchGlossary(body, getAuthContext(req));
        sendJson(res, 200, result);
      },
    },
  ];
}
