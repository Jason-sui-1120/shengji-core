import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// env.mjs —— 进程环境加载与路径常量。
// 在 import 时立即加载 .env.local（模块缓存保证只执行一次），
// 之后再被 config.mjs / index.mjs 引用时，process.env 已就绪。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, "..");

// 本地回归与容量实验可使用独立数据目录，避免测试会议写入开发或生产数据。
export const dataDir = process.env.VOICE_DATA_DIR
  ? path.resolve(process.env.VOICE_DATA_DIR)
  : path.join(rootDir, "data");
export const audioDir = path.join(dataDir, "audio");
export const dbPath = path.join(dataDir, "app.db");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(path.join(rootDir, ".env.local"));

// 共享模型配置：models.json 由 git 管理、两端同步，是模型选择的权威来源。
// 构建产物从 dist/server 启动时 rootDir 是 dist/，models.json 在仓库根目录，
// 与 config.json 一样需要向上查找，否则部署环境会静默回退到硬编码默认模型。
function findModelsFile() {
  let directory = rootDir;
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(directory, "models.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "";
}

function loadModelsConfig() {
  try {
    const filePath = findModelsFile();
    if (!filePath) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const result = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith("_")) result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

const modelsConfig = loadModelsConfig();

// 仅读取 models.json 的值（不看环境变量），供 config.mjs 实现"models.json 权威"的模型键。
export function modelsConfigValue(key) {
  return modelsConfig[key];
}

export function modelConfig(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (modelsConfig[key] !== undefined) return modelsConfig[key];
  return fallback;
}
