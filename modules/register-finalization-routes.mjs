/**
 * register-finalization-routes.mjs —— 共享归档路由装配（唯一来源）。
 *
 * 尾段收口与超时降级是会议链路最易出事故的环节，业务流程只允许在这里出现一次。
 * deps 约定（端侧含权限校验与异步任务实现）：
 *   readJson(req)                          → Promise<body>
 *   sendJson(res, status, payload)         → void
 *   canAccess(meetingId, authContext)      → Promise<boolean>
 *   getFinalizationGate(meetingId, opts)   → Promise<gate>
 *   saveFinalizedDraft(meetingId, finalMinutes, opts) → Promise<result>
 *   finalizeMeeting(meetingId, opts)       → Promise<result>
 *   startFinalizeDraftJob(meetingId, model) → jobStatus（202 异步）
 *   getFinalizeDraftJobStatus(meetingId)   → jobStatus
 *   getAuthContext(req)                    → authContext（请求级，req.shengjiAuthContext）
 */
export function registerFinalizationRoutes(deps) {
  const { readJson, sendJson, canAccess, getFinalizationGate, saveFinalizedDraft, finalizeMeeting, startFinalizeDraftJob, getFinalizeDraftJobStatus, getAuthContext } = deps;

  const forbidden = (res) => sendJson(res, 403, { error: "无权限操作此会议" });

  return [
    {
      method: "GET",
      pattern: /^\/api\/meetings\/finalization-status$/,
      async handler(req, res, _params, url) {
        const meetingId = Number(url.searchParams.get("meetingId") || 1);
        if (!(await canAccess(meetingId, getAuthContext(req)))) { forbidden(res); return; }
        const forceTailFallback = url.searchParams.get("forceTailFallback") === "1";
        sendJson(res, 200, await getFinalizationGate(meetingId, { forceTailFallback }));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/meetings\/finalize-draft\/status$/,
      async handler(req, res, _params, url) {
        const meetingId = Number(url.searchParams.get("meetingId") || 1);
        if (!(await canAccess(meetingId, getAuthContext(req)))) { forbidden(res); return; }
        sendJson(res, 200, await getFinalizeDraftJobStatus(meetingId));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/meetings\/finalize$/,
      async handler(req, res) {
        const body = await readJson(req);
        const meetingId = Number(body.meetingId || 1);
        if (!(await canAccess(meetingId, getAuthContext(req)))) { forbidden(res); return; }
        if (body.finalMinutes) {
          sendJson(res, 200, await saveFinalizedDraft(meetingId, body.finalMinutes, { projectId: body.projectId, moveActions: body.moveActions }));
          return;
        }
        sendJson(res, 200, await finalizeMeeting(meetingId, { save: true }));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/meetings\/finalize-draft$/,
      async handler(req, res) {
        const body = await readJson(req);
        const meetingId = Number(body.meetingId || 1);
        if (!(await canAccess(meetingId, getAuthContext(req)))) { forbidden(res); return; }
        // 归档草稿可能包含分块事实提取和较长模型生成；不能让浏览器请求一直占着，
        // 否则云平台代理会先返回 502/503。任务在服务端完成，前端轮询状态即可。
        sendJson(res, 202, startFinalizeDraftJob(meetingId, body.model));
      },
    },
  ];
}
