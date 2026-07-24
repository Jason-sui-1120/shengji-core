/**
 * speaker-core.mjs —— 说话人通用工具（无 DB、无状态）。
 * diarization 响应归一化、置信度/时间规范化、音频 URL 生成、AI 可用性判断。
 */
import path from "node:path";
import { AIT_PUBLIC_BASE_URL, AI_GATEWAY_BASE_URL } from "./config.mjs";
import { normalizeSpeakerKey } from "./text-utils.mjs";

export function hasAiAccess() {
  return Boolean(AI_GATEWAY_BASE_URL || process.env.AIT_API_KEY);
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

export function getSpeakerAudioUrl(audioPath, wav) {
  if (AIT_PUBLIC_BASE_URL && audioPath) {
    const fileName = encodeURIComponent(path.basename(audioPath));
    return `${AIT_PUBLIC_BASE_URL.replace(/\/$/, "")}/api/audio/${fileName}`;
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
