/**
 * speaker-core.mjs —— 说话人通用工具（无 DB、无状态）。
 * diarization 响应归一化、置信度/时间规范化、音频 URL 生成、AI 可用性判断。
 */
import path from "node:path";
import {
  AIT_PUBLIC_BASE_URL, PUBLIC_BASE_URL, AIT_AUDIO_URL_SIGNING_SECRET,
  AI_GATEWAY_BASE_URL, AIT_API_KEY, SESSION_SIGNATURE,
} from "./config.mjs";
import { createRollingAudioAccessQuery } from "./audio-access-signature.mjs";
import { normalizeSpeakerKey } from "./text-utils.mjs";

export function hasAiAccess() {
  return Boolean(AI_GATEWAY_BASE_URL || AIT_API_KEY);
}

export function normalizeDiarizationTime(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number > 1000 ? number / 1000 : number;
}

export function normalizeConfidence(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 70;
  return Math.max(1, Math.min(99, number <= 1 ? Math.round(number * 100) : Math.round(number)));
}

/**
 * 说话人模型读取的是应用生成的短时签名音频 URL。大多数部署只配置
 * PUBLIC_BASE_URL；AIT_PUBLIC_BASE_URL 仅在 AI 回源域名与应用域名不同时覆盖。
 * 不能要求两份含义高度重叠的配置同时存在，否则大窗口会在调用分离模型前
 * 因 data URL 超限静默丢弃。
 */
export function resolveSpeakerPublicBaseUrl(
  aitPublicBaseUrl = AIT_PUBLIC_BASE_URL,
  publicBaseUrl = PUBLIC_BASE_URL,
) {
  return String(aitPublicBaseUrl || publicBaseUrl || "").trim().replace(/\/$/, "");
}

export function getSpeakerAudioUrl(audioPath, wav, meetingId) {
  const publicBaseUrl = resolveSpeakerPublicBaseUrl();
  if (publicBaseUrl && audioPath) {
    const fileName = path.basename(audioPath);
    // 公司端复用既有 SESSION_SIGNATURE 作为兼容密钥，并以 PURPOSE 做 HMAC 域隔离；
    // 后续可单独配置 AIT_AUDIO_URL_SIGNING_SECRET，无需变更调用方。
    const access = createRollingAudioAccessQuery({
      secret: AIT_AUDIO_URL_SIGNING_SECRET || SESSION_SIGNATURE,
      meetingId,
      fileName,
    });
    if (access) {
      const params = new URLSearchParams({ expires: String(access.expiresAt), signature: access.signature });
      return `${publicBaseUrl}/api/audio/${encodeURIComponent(fileName)}?${params}`;
    }
    // 公网端本来就是公开音频路由，未配置签名密钥时保留原 URL 行为，
    // 不能因为公司端的权限修复让大于 data URL 上限的窗口失去分离能力。
    return `${publicBaseUrl}/api/audio/${encodeURIComponent(fileName)}`;
  }
  if (!wav?.length || wav.length > 2_000_000) return "";
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}

export function extractDominantSpeaker(payload, meetingId) {
  const candidates = [
    payload?.segments,
    payload?.diarization,
    payload?.speaker_segments,
    payload?.result?.segments,
    payload?.data?.segments,
    payload?.data?.diarization,
  ].find((value) => Array.isArray(value));

  if (Array.isArray(candidates) && candidates.length) {
    const scores = new Map();
    for (const segment of candidates) {
      const rawSpeaker = segment.speaker ?? segment.speaker_id ?? segment.spk ?? segment.label ?? segment.user;
      if (rawSpeaker === undefined || rawSpeaker === null || rawSpeaker === "") continue;
      const start = Number(segment.start ?? segment.begin ?? segment.start_time ?? 0);
      const end = Number(segment.end ?? segment.stop ?? segment.end_time ?? start + 1);
      const weight = Math.max(1, end - start);
      const key = normalizeSpeakerKey(rawSpeaker, meetingId);
      scores.set(key, (scores.get(key) || 0) + weight);
    }
    const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) return { speaker: best[0], confidence: Math.min(95, Math.max(60, Math.round(best[1] * 10))) };
  }

  const directSpeaker = payload?.speaker ?? payload?.speaker_id ?? payload?.spk ?? payload?.user;
  if (directSpeaker !== undefined && directSpeaker !== null && directSpeaker !== "") {
    return { speaker: normalizeSpeakerKey(directSpeaker, meetingId), confidence: 70 };
  }

  return null;
}
