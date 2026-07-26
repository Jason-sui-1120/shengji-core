/**
 * register-state-routes.mjs —— 共享状态与转写路由装配（唯一来源）。
 *
 * deps 约定：
 *   readJson(req)                                  → Promise<body>
 *   sendJson(res, status, payload)                 → void
 *   getState(authContext)                          → Promise<state>
 *   searchTranscripts(query, project, authContext) → Promise<result>
 *   insertTranscript(body, authContext)            → Promise<row>
 *   updateTranscript(id, body, authContext)        → Promise<row>
 *   getAuthContext(req)                            → authContext
 */
export function registerStateRoutes(deps) {
  const { readJson, sendJson, getState, searchTranscripts, insertTranscript, updateTranscript, getAuthContext } = deps;
  return [
    {
      method: "GET",
      pattern: /^\/api\/state$/,
      async handler(req, res) {
        sendJson(res, 200, await getState(getAuthContext(req)));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/search\/transcripts$/,
      async handler(req, res, _params, url) {
        sendJson(res, 200, await searchTranscripts(url.searchParams.get("q") || "", url.searchParams.get("project") || "", getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/transcripts$/,
      async handler(req, res) {
        const body = await readJson(req);
        sendJson(res, 200, await insertTranscript(body, getAuthContext(req)));
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/transcripts\/(\d+)$/,
      async handler(req, res, params) {
        const body = await readJson(req);
        sendJson(res, 200, await updateTranscript(Number(params[1]), body, getAuthContext(req)));
      },
    },
  ];
}
