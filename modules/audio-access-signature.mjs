/**
 * 滚动音频的短时回源签名。
 *
 * 仅用于 AI 服务拉取当前会议的临时 rolling WAV；它不替代用户的会议访问权限，
 * 也不适用于完整会议录音或回放文件。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PURPOSE = "shengji:rolling-audio:v1";
const MAX_TTL_MS = 10 * 60 * 1000;

export function isRollingMeetingAudioFile(fileName, meetingId) {
  const id = Number(meetingId || 0);
  return Number.isInteger(id) && id > 0
    && new RegExp(`^meeting-${id}-rolling-[A-Za-z0-9._-]+\\.wav$`).test(String(fileName || ""));
}

function payload({ meetingId, fileName, expiresAt }) {
  return `${PURPOSE}|${Number(meetingId)}|${String(fileName)}|${Number(expiresAt)}`;
}

export function createRollingAudioSignature({ secret, meetingId, fileName, expiresAt }) {
  if (!secret || !isRollingMeetingAudioFile(fileName, meetingId)) return "";
  return createHmac("sha256", String(secret))
    .update(payload({ meetingId, fileName, expiresAt }))
    .digest("hex");
}

export function createRollingAudioAccessQuery({ secret, meetingId, fileName, now = Date.now(), ttlMs = 5 * 60 * 1000 }) {
  const expiresAt = Math.floor(Number(now) + Math.min(MAX_TTL_MS, Math.max(1_000, Number(ttlMs) || 0)));
  const signature = createRollingAudioSignature({ secret, meetingId, fileName, expiresAt });
  return signature ? { expiresAt, signature } : null;
}

export function verifyRollingAudioAccessQuery({ secret, meetingId, fileName, expiresAt, signature, now = Date.now() }) {
  const expiry = Number(expiresAt || 0);
  if (!secret || !signature || !isRollingMeetingAudioFile(fileName, meetingId)) return false;
  if (!Number.isFinite(expiry) || expiry <= Number(now) || expiry > Number(now) + MAX_TTL_MS) return false;
  const expected = createRollingAudioSignature({ secret, meetingId, fileName, expiresAt: expiry });
  const actualBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
