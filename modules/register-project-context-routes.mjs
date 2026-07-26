/**
 * register-project-context-routes.mjs —— 共享项目上下文路由装配（唯一来源）。
 *
 * deps 约定（端侧含权限校验与具体实现）：
 *   readJson(req)                                  → Promise<body>
 *   sendJson(res, status, payload)                 → void
 *   updateProjectMemory(projectId, body, authContext)     → Promise<result>
 *   chatWithProject(projectId, body, authContext)         → Promise<result>
 *   getProjectChatHistory(projectId, authContext)         → Promise<result>
 *   createActionFromChat(projectId, body, authContext)    → Promise<result>
 *   markProjectChatMemorySaved(projectId, messageId, authContext) → Promise<result>
 *   getAuthContext(req)                            → authContext（请求级，req.shengjiAuthContext）
 */
export function registerProjectContextRoutes(deps) {
  const { readJson, sendJson, updateProjectMemory, chatWithProject, getProjectChatHistory, createActionFromChat, markProjectChatMemorySaved, getAuthContext } = deps;
  return [
    {
      method: "PATCH",
      pattern: /^\/api\/projects\/(\d+)\/memory$/,
      async handler(req, res, params) {
        const body = await readJson(req);
        sendJson(res, 200, await updateProjectMemory(Number(params[1]), body, getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/projects\/(\d+)\/chat$/,
      async handler(req, res, params) {
        const body = await readJson(req);
        sendJson(res, 200, await chatWithProject(Number(params[1]), body, getAuthContext(req)));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/projects\/(\d+)\/chat\/history$/,
      async handler(req, res, params) {
        sendJson(res, 200, await getProjectChatHistory(Number(params[1]), getAuthContext(req)));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/projects\/(\d+)\/chat\/action$/,
      async handler(req, res, params) {
        const body = await readJson(req);
        sendJson(res, 201, await createActionFromChat(Number(params[1]), body, getAuthContext(req)));
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/projects\/(\d+)\/chat\/messages\/(\d+)\/memory-saved$/,
      async handler(req, res, params) {
        sendJson(res, 200, await markProjectChatMemorySaved(Number(params[1]), Number(params[2]), getAuthContext(req)));
      },
    },
  ];
}
