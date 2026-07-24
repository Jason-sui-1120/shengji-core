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

// 共享模型配置：models.json 优先级低于 .env.local，高于硬编码默认值
function loadModelsConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir, "models.json"), "utf8"));
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

export function modelConfig(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (modelsConfig[key] !== undefined) return modelsConfig[key];
  return fallback;
}
