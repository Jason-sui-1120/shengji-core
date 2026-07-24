/**
 * deployment.mjs —— 部署环境配置。
 * 两端共用代码，但认证/DB/权限/AI 工具调用方式不同，通过此文件配置区分。
 *
 * 公网端（Jason-sui-1120/shengji-voice-recorder）：
 *   - DEPLOYMENT_TYPE=public
 *   - SQLite，无认证，无多用户权限，AI 工具走网关
 *
 * 公司端（liupeisheng002/shengji-lianjia）：
 *   - DEPLOYMENT_TYPE=enterprise
 *   - MySQL，CAS 认证，多用户权限，AI 工具直连或走网关
 */

export const DEPLOYMENT_TYPE = process.env.DEPLOYMENT_TYPE || "public";
export const IS_ENTERPRISE = DEPLOYMENT_TYPE === "enterprise";
export const IS_PUBLIC = DEPLOYMENT_TYPE === "public";

// === DB 配置 ===
export const DB_TYPE = IS_ENTERPRISE ? "mysql" : "sqlite";

// === 认证配置 ===
export const AUTH_ENABLED = IS_ENTERPRISE;
export const AUTH_TYPE = IS_ENTERPRISE ? "cas" : "none";

// === 多用户权限 ===
export const MULTI_USER_ENABLED = IS_ENTERPRISE;
export const PERMISSIONS_ENABLED = IS_ENTERPRISE;

// === AI 工具调用 ===
export const AI_TOOL_MODE = IS_ENTERPRISE ? "direct" : "gateway";
// direct: 直接调用 AIT API（公司内网）
// gateway: 通过 AI 网关（公网）
