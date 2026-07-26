/**
 * try-shared-routes.mjs —— 共享路由分发器（唯一来源）。
 *
 * 两端 index.mjs 不得各自实现不同签名的分发器；统一调用本模块。
 * 签名固定为 trySharedRoutes(routes, req, res, url)，handler 固定接收 (req, res, params, url)。
 *
 * @param {Array} routes - register-*.mjs 返回的路由表
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url - 已解析的请求 URL（含 searchParams）
 * @returns {Promise<boolean>} 是否命中并处理了某个共享路由
 */
export async function trySharedRoutes(routes, req, res, url) {
  for (const r of routes) {
    if (r.method !== "*" && req.method !== r.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    // 测试环境标记：证明请求命中了共享路由实现（不是端侧旧路由）。
    // 仅 NODE_ENV=test 或 SHENGJI_ROUTE_SOURCE=1 时输出，生产不受影响。
    if (process.env.NODE_ENV === "test" || process.env.SHENGJI_ROUTE_SOURCE === "1") {
      if (typeof res.setHeader === "function") res.setHeader("x-shengji-route-source", "core");
    }
    await r.handler(req, res, m, url);
    return true;
  }
  return false;
}
