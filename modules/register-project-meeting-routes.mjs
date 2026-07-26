/**
 * register-project-meeting-routes.mjs —— 共享项目/会议 CRUD 路由装配（唯一来源）。
 *
 * deps 约定（端侧含权限校验与具体实现）：
 *   readJson(req)                          → Promise<body>
 *   sendJson(res, status, payload)         → void
 *   createMeeting(body, authContext)       → Promise<meeting>
 *   createProject(body, authContext)       → Promise<project>
 *   getTrash(authContext)                  → Promise<trash>
 *   softDeleteProject(id, authContext)     → Promise<result>
 *   restoreProject(id, authContext)        → Promise<result>
 *   purgeProject(id, authContext)          → Promise<result>
 *   softDeleteMeeting(id, authContext)     → Promise<result>
 *   restoreMeeting(id, authContext)        → Promise<result>
 *   purgeMeeting(id, authContext)          → Promise<result>
 *   purgeAction(id, authContext)           → Promise<result>
 *   getAuthContext(req)                    → authContext（请求级，req.shengjiAuthContext）
 */
export function registerProjectMeetingRoutes(deps) {
  const { readJson, sendJson, createMeeting, createProject, getTrash,
    softDeleteProject, restoreProject, purgeProject,
    softDeleteMeeting, restoreMeeting, purgeMeeting, purgeAction,
    getAuthContext } = deps;

  return [
    {
      method: "POST",
      pattern: /^\/api\/meetings$/,
      async handler(req, res) {
        const body = await readJson(req);
        sendJson(res, 201, await createMeeting(body, getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/projects$/,
      async handler(req, res) {
        const body = await readJson(req);
        sendJson(res, 201, await createProject(body, getAuthContext(req)));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/trash$/,
      async handler(req, res) {
        sendJson(res, 200, await getTrash(getAuthContext(req)));
      },
    },
    {
      method: "*",
      pattern: /^\/api\/projects\/(\d+)$/,
      async handler(req, res, params, url) {
        const id = Number(params[1]);
        const auth = getAuthContext(req);
        const action = url.searchParams.get("action");
        if (req.method === "DELETE" && action === "purge") { sendJson(res, 200, await purgeProject(id, auth)); return; }
        if (req.method === "POST" && action === "restore") { sendJson(res, 200, await restoreProject(id, auth)); return; }
        if (req.method === "DELETE") { sendJson(res, 200, await softDeleteProject(id, auth)); return; }
        sendJson(res, 405, { error: "method not allowed" });
      },
    },
    {
      method: "*",
      pattern: /^\/api\/meetings\/(\d+)$/,
      async handler(req, res, params, url) {
        const id = Number(params[1]);
        const auth = getAuthContext(req);
        const action = url.searchParams.get("action");
        if (req.method === "DELETE" && action === "purge") { sendJson(res, 200, await purgeMeeting(id, auth)); return; }
        if (req.method === "POST" && action === "restore") { sendJson(res, 200, await restoreMeeting(id, auth)); return; }
        if (req.method === "DELETE") { sendJson(res, 200, await softDeleteMeeting(id, auth)); return; }
        sendJson(res, 405, { error: "method not allowed" });
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/actions\/(\d+)\/purge$/,
      async handler(req, res, params) {
        sendJson(res, 200, await purgeAction(Number(params[1]), getAuthContext(req)));
      },
    },
  ];
}
