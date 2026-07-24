import fs from "node:fs";
import path from "node:path";
import { audioDir } from "./env.mjs";
import { AI_GATEWAY_BASE_URL, AI_GATEWAY_SHARED_TOKEN } from "./config.mjs";

export function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export function sendAudio(res, fileName) {
  const safeName = path.basename(decodeURIComponent(fileName));
  if (!/^[a-zA-Z0-9._-]+\.wav$/.test(safeName)) {
    sendJson(res, 400, { error: "invalid audio file" });
    return;
  }
  const audioPath = path.join(audioDir, safeName);
  if (!fs.existsSync(audioPath)) {
    sendJson(res, 404, { error: "audio file not found" });
    return;
  }
  res.writeHead(200, {
    "content-type": "audio/wav",
    "cache-control": "private, max-age=3600",
  });
  fs.createReadStream(audioPath).pipe(res);
}

export function sendMarkdown(res, payload) {
  res.writeHead(payload.status || 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(payload.fileName || "meeting-minutes.md")}`,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  });
  res.end(payload.content || "");
}

export function sendGatewayResult(res, result) {
  const text = result?.text || "";
  res.writeHead(Number(result?.status || 502), {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-ai-gateway-token",
  });
  res.end(text);
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function isGatewayAuthorized(req) {
  if (!AI_GATEWAY_SHARED_TOKEN) return true;
  return req.headers["x-ai-gateway-token"] === AI_GATEWAY_SHARED_TOKEN;
}

export function getGatewayHeaders() {
  return AI_GATEWAY_SHARED_TOKEN ? { "x-ai-gateway-token": AI_GATEWAY_SHARED_TOKEN } : {};
}

export function toGatewayHttpUrl(pathname) {
  return `${AI_GATEWAY_BASE_URL}${pathname}`;
}

export function toGatewayWsUrl(pathname, search = "") {
  return `${AI_GATEWAY_BASE_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}${pathname}${search}`;
}
