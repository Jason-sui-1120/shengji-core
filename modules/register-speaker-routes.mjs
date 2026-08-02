/**
 * register-speaker-routes.mjs —— 共享说话人路由装配（唯一来源）。
 *
 * deps 约定（端侧含权限校验与具体实现）：
 *   readJson(req)                                  → Promise<body>
 *   sendJson(res, status, payload)                 → void
 *   renameSpeaker(body, authContext)               → Promise<result>
 *   deleteSpeaker(body, authContext)               → Promise<result>
 *   reconcileSpeakers(meetingId, authContext)      → Promise<result>
 *   backfillSpeakers(meetingId, authContext)       → Promise<result>
 *   reconcileByVoiceCluster(meetingId, body, authContext) → Promise<result>
 *   getAuthContext(req)                            → authContext（请求级，req.shengjiAuthContext）
 */
export function registerSpeakerRoutes(deps) {
  const { readJson, sendJson, renameSpeaker, deleteSpeaker, reconcileSpeakers, backfillSpeakers, reconcileByVoiceCluster, getAuthContext } = deps;
  return [
    {
      method: "PATCH",
      pattern: /^\/api\/speakers\/rename$/,
      async handler(req, res) {
        const body = await readJson(req);
        // 入参契约校验：缺 from/to 是客户端错误（400），不应冒泡成 500。
        const from = String(body?.from || "").trim();
        const to = String(body?.to || "").trim();
        if (!from || !to) { sendJson(res, 400, { error: "speaker rename requires from and to" }); return; }
        sendJson(res, 200, await renameSpeaker(body, getAuthContext(req)));
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/speakers\/delete$/,
      async handler(req, res) {
        const body = await readJson(req);
        sendJson(res, 200, await deleteSpeaker(body, getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/speakers\/reconcile$/,
      async handler(req, res) {
        const body = await readJson(req);
        const meetingId = Number(body.meetingId || 0);
        if (!Number.isInteger(meetingId) || meetingId <= 0) { sendJson(res, 400, { error: "meetingId required (positive integer)" }); return; }
        sendJson(res, 200, await reconcileSpeakers(meetingId, getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/speakers\/backfill$/,
      async handler(req, res) {
        const body = await readJson(req);
        const meetingId = Number(body.meetingId || 0);
        if (!Number.isInteger(meetingId) || meetingId <= 0) { sendJson(res, 400, { error: "meetingId required (positive integer)" }); return; }
        sendJson(res, 200, await backfillSpeakers(meetingId, getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/speakers\/reconcile-voice-cluster$/,
      async handler(req, res) {
        const body = await readJson(req);
        const meetingId = Number(body.meetingId || 0);
        if (!Number.isInteger(meetingId) || meetingId <= 0) { sendJson(res, 400, { error: "meetingId required (positive integer)" }); return; }
        sendJson(res, 200, await reconcileByVoiceCluster(meetingId, body, getAuthContext(req)));
      },
    },
  ];
}
