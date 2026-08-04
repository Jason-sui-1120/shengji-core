// core 共享权限校验契约——端侧注入实现
// 公网端（单用户 SQLite）：所有 can* 返回 true
// 公司端（多用户 MySQL）：真实权限校验（用户/项目/会议归属）

/**
 * 权限上下文（请求级）
 * @typedef {Object} AuthContext
 * @property {number|string} id - 用户 ID
 * @property {boolean} [isAdmin] - 是否管理员
 * @property {string} [name] - 用户名
 */

/**
 * 权限校验接口——所有 core 路由通过此接口做权限检查
 * @typedef {Object} PermissionAdapter
 * @property {(meetingId: number, auth: AuthContext) => Promise<boolean>} canAccessMeeting
 * @property {(projectId: number, auth: AuthContext) => Promise<boolean>} canAccessProject
 * @property {(actionId: number, auth: AuthContext) => Promise<boolean>} canAccessAction
 * @property {(meetingId: number, auth: AuthContext) => Promise<boolean>} canAccessFinalized
 * @property {(auth: AuthContext) => Promise<boolean>} canEditGlossary
 */

/**
 * 创建单用户模式的权限适配器（公网端用）
 * @returns {PermissionAdapter}
 */
export function createSingleUserPermissions() {
  const always = async () => true;
  return {
    canAccessMeeting: always,
    canAccessProject: always,
    canAccessAction: always,
    canAccessFinalized: always,
    canEditGlossary: always,
  };
}

/**
 * 验证权限适配器完整性（core 路由启动前自检）
 * @param {PermissionAdapter} adapter
 * @returns {{ok: boolean, missing: string[]}}
 */
export function validatePermissionAdapter(adapter) {
  const required = ["canAccessMeeting", "canAccessProject", "canAccessAction", "canAccessFinalized", "canEditGlossary"];
  const missing = required.filter((key) => typeof adapter?.[key] !== "function");
  return { ok: missing.length === 0, missing };
}

/**
 * 权限拒绝时发送 403 响应
 * @param {object} res - HTTP response
 * @param {string} [message] - 错误消息
 */
export function forbidden(res, message = "无权限访问此资源") {
  res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}
