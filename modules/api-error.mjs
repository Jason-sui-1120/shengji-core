// core 结构化错误契约——统一两端错误响应格式
// 目标：所有 4xx/5xx 错误响应用同一结构，前端可统一处理

/**
 * 结构化错误响应
 * @typedef {Object} ApiError
 * @property {string} error - 人类可读错误消息
 * @property {string} code - 机器可读错误码（SCREAMING_SNAKE）
 * @property {number} status - HTTP 状态码
 * @property {object} [details] - 可选附加上下文
 */

/** 标准错误码 */
export const ErrorCodes = {
  // 4xx 客户端错误
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  MISSING_PARAM: "MISSING_PARAM",
  // 5xx 服务端错误
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  AI_GATEWAY_ERROR: "AI_GATEWAY_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
};

/**
 * 构造结构化错误对象
 * @param {string} code - ErrorCodes 中的错误码
 * @param {string} message - 人类可读消息
 * @param {number} status - HTTP 状态码
 * @param {object} [details] - 附加上下文
 * @returns {ApiError}
 */
export function apiError(code, message, status, details) {
  const err = { error: String(message || "未知错误"), code: String(code || "INTERNAL_ERROR"), status: Number(status || 500) };
  if (details && typeof details === "object") err.details = details;
  return err;
}

/**
 * 发送结构化错误响应（依赖 sendJson）
 * @param {object} res - HTTP response
 * @param {Function} sendJson - sendJson(res, status, payload)
 * @param {string} code - 错误码
 * @param {string} message - 消息
 * @param {number} status - HTTP 状态码
 * @param {object} [details] - 附加
 */
export function sendError(res, sendJson, code, message, status, details) {
  sendJson(res, status, apiError(code, message, status, details));
}

/** 常用错误快捷构造 */
export const errors = {
  badRequest: (msg, details) => apiError(ErrorCodes.BAD_REQUEST, msg, 400, details),
  unauthorized: (msg = "未授权", details) => apiError(ErrorCodes.UNAUTHORIZED, msg, 401, details),
  forbidden: (msg = "无权限访问此资源", details) => apiError(ErrorCodes.FORBIDDEN, msg, 403, details),
  notFound: (msg = "资源不存在", details) => apiError(ErrorCodes.NOT_FOUND, msg, 404, details),
  missingParam: (param, details) => apiError(ErrorCodes.MISSING_PARAM, `缺少必填参数：${param}`, 400, details),
  validation: (msg, details) => apiError(ErrorCodes.VALIDATION_FAILED, msg, 400, details),
  internal: (msg = "服务器内部错误", details) => apiError(ErrorCodes.INTERNAL_ERROR, msg, 500, details),
  upstream: (msg, details) => apiError(ErrorCodes.UPSTREAM_ERROR, msg, 502, details),
  aiGateway: (msg, details) => apiError(ErrorCodes.AI_GATEWAY_ERROR, msg, 502, details),
  database: (msg, details) => apiError(ErrorCodes.DATABASE_ERROR, msg, 500, details),
};

/**
 * 把异常归一化为结构化错误
 * @param {unknown} err - 捕获的异常
 * @param {string} [fallbackCode] - 默认错误码
 * @returns {ApiError}
 */
export function normalizeError(err, fallbackCode = ErrorCodes.INTERNAL_ERROR) {
  if (err && typeof err === "object" && err.error && err.code) {
    return { error: String(err.error), code: String(err.code), status: Number(err.status || 500), ...(err.details ? { details: err.details } : {}) };
  }
  const message = err instanceof Error ? err.message : String(err || "未知错误");
  return apiError(fallbackCode, message, fallbackCode === ErrorCodes.INTERNAL_ERROR ? 500 : 400);
}
