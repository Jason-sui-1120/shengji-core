/**
 * register-meeting-extras-routes.mjs —— 共享议题/总结块/待办路由装配（唯一来源）。
 *
 * deps 约定（端侧含权限校验与存储实现）：
 *   readJson(req)                                   → Promise<body>
 *   sendJson(res, status, payload)                  → void
 *   listMeetingSegments(meetingId, authContext)     → Promise<rows>
 *   replaceSummaryBlock(body, authContext)          → Promise<void>
 *   insertAction(body, authContext)                 → Promise<row>
 *   updateAction(id, body, authContext)             → Promise<row>
 *   softDeleteAction(id, authContext)               → Promise<row>
 *   restoreAction(id, authContext)                  → Promise<row>
 *   getAuthContext(req)                             → authContext
 */
export function registerMeetingExtrasRoutes(deps) {
  const { readJson, sendJson, listMeetingSegments, replaceSummaryBlock, insertAction, updateAction, softDeleteAction, restoreAction, getAuthContext } = deps;
  return [
    {
      method: "GET",
      pattern: /^\/api\/meeting-segments$/,
      async handler(req, res, _params, url) {
        const meetingId = Number(url.searchParams.get("meetingId") || 1);
        sendJson(res, 200, await listMeetingSegments(meetingId, getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/summary-blocks$/,
      async handler(req, res) {
        const body = await readJson(req);
        await replaceSummaryBlock(body, getAuthContext(req));
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/actions$/,
      async handler(req, res) {
        const body = await readJson(req);
        sendJson(res, 200, await insertAction(body, getAuthContext(req)));
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/actions\/(\d+)$/,
      async handler(req, res, params) {
        const body = await readJson(req);
        sendJson(res, 200, await updateAction(Number(params[1]), body, getAuthContext(req)));
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/actions\/(\d+)$/,
      async handler(req, res, params) {
        sendJson(res, 200, await softDeleteAction(Number(params[1]), getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/actions\/(\d+)\/restore$/,
      async handler(req, res, params) {
        sendJson(res, 200, await restoreAction(Number(params[1]), getAuthContext(req)));
      },
    },
  ];
}
