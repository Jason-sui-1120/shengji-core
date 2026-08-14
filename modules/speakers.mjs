/**
 * speakers.mjs —— 说话人识别/分离核心逻辑。
 * embedding 匹配、本地特征匹配、diarization 调用与响应归一化、会后归集。
 */
import {
  AIT_SPEAKER_EMBEDDING_MODEL, AIT_SPEAKER_DIARIZATION_MODEL,
  SPEAKER_EMBEDDING_THRESHOLD, SPEAKER_CANDIDATE_THRESHOLD,
  SPEAKER_CANDIDATE_PROMOTE_COUNT, SPEAKER_DIARIZATION_MIN_SEGMENT_SECONDS,
} from "./config.mjs";
import { normalizeVector, safeParseJson } from "./speaker-utils.mjs";
import { hasAiAccess, getSpeakerAudioUrl, normalizeDiarizationTime, normalizeConfidence } from "./speaker-core.mjs";
import { extractVoiceFeatures, getFeatureDistance, mergeVoiceFeatures } from "./voice-features.mjs";
import { normalizeTranscriptSegment } from "./text-utils.mjs";
import { getWavDurationSeconds, sliceWavBySeconds } from "./audio-utils.mjs";
import { callSpeakerEmbedding, callSpeakerDiarization } from "./speaker-gateway.mjs";
import { createMeetingSpeakerTrackManager } from "./meeting-speaker-track-manager.mjs";
import {
  listProfiles, insertProfile, bumpProfileFeatures, setProfileFeatures,
  deleteProfileById, renameProfileLabel, getNextSpeakerLabel,
} from "./speaker-store.mjs";

const meetingSpeakerTrackManager = createMeetingSpeakerTrackManager({
  listProfiles,
  insertProfile,
  bumpProfileFeatures,
  setProfileFeatures,
  deleteProfileById,
  renameProfileLabel,
  getNextSpeakerLabel,
}, {
  matchThreshold: SPEAKER_EMBEDDING_THRESHOLD,
  candidateThreshold: SPEAKER_CANDIDATE_THRESHOLD,
  candidatePromoteCount: SPEAKER_CANDIDATE_PROMOTE_COUNT,
});

function summarizeSpeakerFailure(response, fallback = "unknown") {
  const status = Number(response?.status || 0);
  const requestId = String(response?.requestId || "").trim();
  let detail = fallback;
  try {
    const payload = JSON.parse(String(response?.text || ""));
    detail = String(payload?.error?.message || payload?.error || payload?.message || payload?.code || fallback);
  } catch {
    detail = String(response?.text || fallback);
  }
  const safeDetail = detail
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:signature|token|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 180);
  return `status=${status || "network"}${requestId ? ` requestId=${requestId}` : ""} detail=${safeDetail}`;
}

export async function identifySpeakerFromAudio({ meetingId, wav, audioPath, fallbackSpeaker = "" }) {
  if (!wav?.length) return null;

  const embeddingResult = await identifySpeakerByEmbedding({ meetingId, wav, fallbackSpeaker });
  if (embeddingResult) return embeddingResult;
  // 网关短暂不可用时不能再启用另一套本地特征编号器，否则同一会议会出现
  // “embedding 说话人”和“local 说话人”两套互不认识的轨道。保持当前暂定轨道，
  // 等 45 秒窗口或会后聚类继续用统一管理器纠正。
  const provisional = String(fallbackSpeaker || "").trim();
  return provisional && provisional !== "待识别"
    ? { speaker: provisional, confidence: 20, source: "realtime_provisional", speakerStatus: "provisional" }
    : null;
}

export async function diarizeSpeakerSegments({ meetingId, wav, audioPath, timeoutMs }) {
  if (!hasAiAccess() || !wav?.length) {
    console.warn(`[speaker-diarization] meeting=${Number(meetingId || 0)} skipped reason=${!hasAiAccess() ? "ai_access_unavailable" : "audio_empty"}`);
    return [];
  }
  const audioUrl = getSpeakerAudioUrl(audioPath, wav, meetingId);
  if (!/^(https?:\/\/|data:audio\/wav;base64,)/i.test(audioUrl)) {
    console.warn(`[speaker-diarization] meeting=${Number(meetingId || 0)} skipped reason=audio_url_unavailable bytes=${Number(wav?.length || 0)} audioPath=${audioPath ? "present" : "missing"}`);
    return [];
  }
  try {
    const response = await callSpeakerDiarization({
      model: AIT_SPEAKER_DIARIZATION_MODEL,
      user: `voice-notes-meeting-${Number(meetingId || 1)}`,
      url: audioUrl,
      // 仅供声纪网关在回源 URL 不可访问时上传到 AIT 临时文件服务；
      // speaker-gateway 会在请求 CampPlus 前移除此字段，不会传给模型端点。
      audioBase64: wav.toString("base64"),
      language: "zh",
      enable_words: true,
      speaker_diarization: true,
      embedding_model: AIT_SPEAKER_EMBEDDING_MODEL,
    }, timeoutMs);
    if (!response.ok) {
      console.warn(`[speaker-diarization] meeting=${Number(meetingId || 0)} failed ${summarizeSpeakerFailure(response)}`);
      return [];
    }
    const payload = JSON.parse(response.text);
    if (payload?.error) {
      console.warn(`[speaker-diarization] meeting=${Number(meetingId || 0)} failed ${summarizeSpeakerFailure({ ...response, text: JSON.stringify(payload) }, "payload_error")}`);
      return [];
    }
    const segments = normalizeDiarizationSegments(payload, meetingId, getWavDurationSeconds(wav));
    if (!segments.length) {
      console.warn(`[speaker-diarization] meeting=${Number(meetingId || 0)} empty status=${Number(response.status || 200)} requestId=${String(response.requestId || "-")}`);
    }
    return segments;
  } catch (error) {
    console.warn(`[speaker-diarization] meeting=${Number(meetingId || 0)} exception=${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export function normalizeDiarizationSegments(payload, meetingId, audioDurationSeconds = 0) {
  const rawSegments = [
    payload?.segments,
    payload?.diarization,
    payload?.speaker_segments,
    payload?.result?.segments,
    payload?.result?.diarization,
    payload?.data?.segments,
    payload?.data?.diarization,
    payload?.data?.speaker_segments,
  ].find((value) => Array.isArray(value));

  if (!Array.isArray(rawSegments) || !rawSegments.length) return [];
  // CampPlus 等分离模型常使用 `speaker_0`/`speaker_1` 的 0 基标签。
  // 不能逐条直接调用 normalizeSpeakerKey：那会把 0 和 1 都归成“说话人 1”。
  // 先在本次模型结果内建立一致的临时轨道映射，保证一个窗口内至少能正确展示
  // “说话人 1/2/3”；跨窗口一致性再由声纹/重叠轨道丰富任务收敛。
  const rawLabels = rawSegments.map((segment) => String(
    segment.speaker ?? segment.speaker_id ?? segment.spk ?? segment.label ?? segment.user ?? "",
  ).trim());
  const numericLabels = rawLabels
    .map((label) => label.match(/(\d+)/)?.[1])
    .filter((value) => value != null)
    .map(Number);
  const zeroBasedLabels = numericLabels.includes(0);
  const speakerByRawLabel = new Map();
  let nextFallbackLabel = 1;
  const labelFor = (rawLabel) => {
    const key = rawLabel || "__default__";
    if (speakerByRawLabel.has(key)) return speakerByRawLabel.get(key);
    const numeric = key.match(/(\d+)/)?.[1];
    const index = numeric == null
      ? nextFallbackLabel
      : Math.max(1, Number(numeric) + (zeroBasedLabels ? 1 : 0));
    nextFallbackLabel = Math.max(nextFallbackLabel, index + 1);
    const label = `说话人 ${index}`;
    speakerByRawLabel.set(key, label);
    return label;
  };

  const normalized = rawSegments
    .map((segment, index) => {
      const rawSpeaker = rawLabels[index];
      const start = normalizeDiarizationTime(segment.start ?? segment.begin ?? segment.start_time ?? segment.startTime ?? segment.from ?? 0);
      const end = normalizeDiarizationTime(segment.end ?? segment.stop ?? segment.end_time ?? segment.endTime ?? segment.to ?? start);
      return {
        speaker: labelFor(rawSpeaker),
        start: Math.max(0, start),
        end: Math.max(0, end),
        text: normalizeTranscriptSegment(segment.text || ""),
        confidence: normalizeConfidence(segment.confidence ?? segment.score ?? segment.prob ?? 0.72),
      };
    })
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const segment of normalized) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.speaker === segment.speaker &&
      segment.start - previous.end <= 0.2
    ) {
      previous.end = Math.max(previous.end, segment.end);
      previous.confidence = Math.max(previous.confidence, segment.confidence);
    } else {
      merged.push({ ...segment });
    }
  }

  const duration = Number(audioDurationSeconds || 0);
  return merged
    .map((segment) => ({
      ...segment,
      end: duration ? Math.min(segment.end, duration) : segment.end,
    }))
    .filter((segment) => segment.end - segment.start >= SPEAKER_DIARIZATION_MIN_SEGMENT_SECONDS);
}

export async function identifySpeakerByEmbedding({ meetingId, wav, fallbackSpeaker = "" }) {
  const embeddingResult = await extractSpeakerEmbedding(wav, meetingId);
  if (!embeddingResult?.embedding?.length) return null;
  const [resolved] = await meetingSpeakerTrackManager.resolveBatch({
    meetingId,
    fallbackLabel: fallbackSpeaker,
    observations: [{
      key: `realtime-${Date.now()}`,
      embedding: embeddingResult.embedding,
      confidence: embeddingResult.confidence,
      durationMs: Math.round(getWavDurationSeconds(wav) * 1000),
      evidenceCount: 1,
      source: "embedding",
      allowProfileLearning: false,
    }],
  });
  return resolved ? {
    speaker: resolved.speaker,
    confidence: resolved.confidence,
    source: resolved.source,
    speakerStatus: resolved.status,
  } : null;
}

/**
 * 把一个文件分离窗口里的临时 speaker_0/1 映射为会议级说话人轨道。
 * 每条临时轨道仅抽取最长的连续语音片段做声纹，避免把多人片段拼在一起；
 * 总发言时长、分段数和最长连续发言只作为“是否足以创建新轨道”的证据强度。
 * 一次完整长发言同样是可靠证据，不能因为窗口内只出现一段就永久停在“待识别”。
 */
export async function resolveDiarizedSpeakerTracks({ meetingId, wav, segments = [], fallbackSpeaker = "" }) {
  if (!wav?.length) return [];
  const byLocalTrack = new Map();
  for (const segment of Array.isArray(segments) ? segments : []) {
    const key = String(segment?.speaker || "").trim();
    const start = Math.max(0, Number(segment?.start || 0));
    const end = Math.max(start, Number(segment?.end || start));
    if (!key || key === "待识别" || end <= start) continue;
    const group = byLocalTrack.get(key) || { key, segments: [], durationMs: 0 };
    group.segments.push({ start, end, confidence: Number(segment?.confidence || 0) });
    group.durationMs += Math.round((end - start) * 1000);
    byLocalTrack.set(key, group);
  }

  const observations = [];
  for (const group of byLocalTrack.values()) {
    const longest = group.segments.slice().sort((left, right) => (right.end - right.start) - (left.end - left.start))[0];
    if (!longest || longest.end - longest.start < 0.8) continue;
    const clip = sliceWavBySeconds(wav, longest.start, longest.end);
    const embeddingResult = await extractSpeakerEmbedding(clip, meetingId);
    if (!embeddingResult?.embedding?.length) continue;
    observations.push({
      key: group.key,
      embedding: embeddingResult.embedding,
      confidence: embeddingResult.confidence,
      durationMs: group.durationMs,
      longestContinuousMs: Math.round((longest.end - longest.start) * 1000),
      evidenceCount: group.segments.length,
      startMs: Math.round(longest.start * 1000),
      source: "rolling_diarization",
      allowProfileLearning: true,
    });
  }
  return meetingSpeakerTrackManager.resolveBatch({ meetingId, observations, fallbackLabel: fallbackSpeaker });
}

/** 会后聚类质心也必须复用同一个会议轨道，不再从说话人 1 重新编号。 */
export async function resolveMeetingSpeakerTracks({ meetingId, observations = [], fallbackSpeaker = "", confirmNewTracks = false }) {
  return meetingSpeakerTrackManager.resolveBatch({ meetingId, observations, fallbackLabel: fallbackSpeaker, confirmNewTracks });
}

export async function extractSpeakerEmbedding(wav, meetingId) {
  if (!hasAiAccess() || !wav?.length) return null;
  try {
    const response = await callSpeakerEmbedding({
      model: AIT_SPEAKER_EMBEDDING_MODEL,
      user: `voice-notes-meeting-${Number(meetingId || 1)}`,
      base64: wav.toString("base64"),
      normalize: true,
      sample_rate: 16000,
    });
    if (!response.ok) {
      console.warn(`[speaker-embedding] meeting=${Number(meetingId || 0)} failed ${summarizeSpeakerFailure(response)}`);
      return null;
    }
    const payload = JSON.parse(response.text);
    if (payload?.error) {
      console.warn(`[speaker-embedding] meeting=${Number(meetingId || 0)} failed ${summarizeSpeakerFailure({ ...response, text: JSON.stringify(payload) }, "payload_error")}`);
      return null;
    }
    const normalized = normalizeSpeakerEmbeddingPayload(payload);
    if (!normalized) {
      console.warn(`[speaker-embedding] meeting=${Number(meetingId || 0)} empty status=${Number(response.status || 200)} requestId=${String(response.requestId || "-")}`);
      return null;
    }
    return normalized;
  } catch (error) {
    console.warn(`[speaker-embedding] meeting=${Number(meetingId || 0)} exception=${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 把 embedding 接口的候选结果收敛成单位向量。保持为纯函数，确保构建/同步时
 * 不会再出现“接口成功但本地缺少 normalizeVector 引用”这类只能在线上触发的错误。
 */
export function normalizeSpeakerEmbeddingPayload(payload) {
  const embeddings = Array.isArray(payload?.embeddings) ? payload.embeddings : [];
  const best = embeddings
    .filter((item) => Array.isArray(item?.embedding) && item.embedding.length)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
  if (!best) return null;
  const embedding = normalizeVector(best.embedding.map(Number));
  if (!embedding.length) return null;
  return { embedding, confidence: Number(best.confidence || 0) };
}

export async function identifySpeakerByLocalProfile({ meetingId, wav }) {
  const features = extractVoiceFeatures(wav);
  if (!features) return null;

  const allProfiles = await listProfiles(null, meetingId);
  const profiles = allProfiles.map((row) => ({
    ...row,
    features: safeParseJson(row.featuresJson),
  })).filter((row) => row.features && !row.features.kind);

  let matched = null;
  for (const profile of profiles) {
    const distance = getFeatureDistance(features, profile.features);
    if (!matched || distance < matched.distance) matched = { ...profile, distance };
  }

  const threshold = 0.22;
  if (matched && matched.distance <= threshold) {
    const merged = mergeVoiceFeatures(matched.features, features, matched.sampleCount);
    await bumpProfileFeatures(null, matched.id, JSON.stringify(merged), new Date().toISOString());
    const confidence = Math.max(55, Math.min(88, Math.round((1 - matched.distance / threshold) * 35 + 55)));
    return { speaker: matched.label, confidence, source: "local" };
  }

  if (allProfiles.length > 0) {
    return { speaker: "待识别", confidence: 0, source: "pending" };
  }

  const label = await getNextSpeakerLabel(null, meetingId);
  await insertProfile(null, meetingId, label, JSON.stringify(features), 1, new Date().toISOString());
  return { speaker: label, confidence: 60, source: "local" };
}
