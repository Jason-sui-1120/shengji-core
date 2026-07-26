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
 *   getAuthContext(req)                            → authContext
 */
export function registerSpeakerRoutes(deps) {
  const { readJson, sendJson, renameSpeaker, deleteSpeaker, reconcileSpeakers, backfillSpeakers, reconcileByVoiceCluster, getAuthContext } = deps;
  return [
    {
      method: "PATCH",
      pattern: /^\/api\/speakers\/rename$/,
      async handler(req, res) {
        const body = await readJson(req);
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
        sendJson(res, 200, await reconcileSpeakers(Number(body.meetingId || 1), getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/speakers\/backfill$/,
      async handler(req, res) {
        const body = await readJson(req);
        sendJson(res, 200, await backfillSpeakers(Number(body.meetingId || 1), getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/speakers\/reconcile-voice-cluster$/,
      async handler(req, res) {
        const body = await readJson(req);
        sendJson(res, 200, await reconcileByVoiceCluster(Number(body.meetingId || 1), body, getAuthContext(req)));
      },
    },
  ];
}
