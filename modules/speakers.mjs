/**
 * speakers.mjs —— 说话人识别/分离核心逻辑。
 * embedding 匹配、本地特征匹配、diarization 调用与响应归一化、会后归集。
 */
import {
  AIT_SPEAKER_EMBEDDING_MODEL, AIT_SPEAKER_DIARIZATION_MODEL,
  SPEAKER_EMBEDDING_THRESHOLD, SPEAKER_CANDIDATE_THRESHOLD,
  SPEAKER_CANDIDATE_PROMOTE_COUNT, SPEAKER_DIARIZATION_MIN_SEGMENT_SECONDS,
} from "./config.mjs";
import { normalizeVector, cosineSimilarity, mergeEmbeddingVector, matchEmbeddingProfile, safeParseJson } from "./speaker-utils.mjs";
import { hasAiAccess, getSpeakerAudioUrl, normalizeDiarizationTime, normalizeConfidence } from "./speaker-core.mjs";
import { extractVoiceFeatures, getFeatureDistance, mergeVoiceFeatures } from "./voice-features.mjs";
import { normalizeSpeakerKey, normalizeTranscriptSegment } from "./text-utils.mjs";
import { getWavDurationSeconds } from "./audio-utils.mjs";
import { callSpeakerEmbedding, callSpeakerDiarization } from "./speaker-gateway.mjs";
import {
  listProfiles, insertProfile, bumpProfileFeatures, setProfileFeatures,
  renameProfileLabel, getNextSpeakerLabel,
} from "./speaker-store.mjs";

export async function identifySpeakerFromAudio({ meetingId, wav, audioPath }) {
  if (!wav?.length) return null;

  const embeddingResult = await identifySpeakerByEmbedding({ meetingId, wav });
  if (embeddingResult) return embeddingResult;
  return identifySpeakerByLocalProfile({ meetingId, wav });
}

export async function diarizeSpeakerSegments({ meetingId, wav, audioPath, timeoutMs }) {
  if (!hasAiAccess() || !wav?.length) return [];
  const audioUrl = getSpeakerAudioUrl(audioPath, wav);
  if (!/^(https?:\/\/|data:audio\/wav;base64,)/i.test(audioUrl)) return [];
  try {
    const response = await callSpeakerDiarization({
      model: AIT_SPEAKER_DIARIZATION_MODEL,
      user: `voice-notes-meeting-${Number(meetingId || 1)}`,
      url: audioUrl,
      speaker_diarization: true,
      embedding_model: AIT_SPEAKER_EMBEDDING_MODEL,
    }, timeoutMs);
    if (!response.ok) return [];
    const payload = JSON.parse(response.text);
    if (payload?.error) return [];
    return normalizeDiarizationSegments(payload, meetingId, getWavDurationSeconds(wav));
  } catch {
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
  const normalized = rawSegments
    .map((segment) => {
      const rawSpeaker = segment.speaker ?? segment.speaker_id ?? segment.spk ?? segment.label ?? segment.user;
      const start = normalizeDiarizationTime(segment.start ?? segment.begin ?? segment.start_time ?? segment.startTime ?? segment.from ?? 0);
      const end = normalizeDiarizationTime(segment.end ?? segment.stop ?? segment.end_time ?? segment.endTime ?? segment.to ?? start);
      return {
        speaker: normalizeSpeakerKey(rawSpeaker ?? "1", meetingId),
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

export async function identifySpeakerByEmbedding({ meetingId, wav }) {
  const embeddingResult = await extractSpeakerEmbedding(wav, meetingId);
  if (!embeddingResult?.embedding?.length) return null;

  const speakerProfiles = (await listProfiles(null, meetingId)).map((row) => ({
    ...row,
    profile: safeParseJson(row.featuresJson),
  }));
  const profiles = speakerProfiles
    .filter((row) => row.profile?.kind === "embedding" && Array.isArray(row.profile.vector));
  const candidates = speakerProfiles
    .filter((row) => row.profile?.kind === "embedding_candidate" && Array.isArray(row.profile.vector));

  // 找出前两名最相似的 profile，计算 margin（第一名与第二名的相似度差）。
  // 硬匹配 0.55 只看第一名，当 006-F 和 001-M 都 ~0.6 时会误归给最高分。
  // 改为 margin 判断：前两名太接近（差 < 0.06）时说明"不可区分"，标待识别而非硬塞。
  const ranked = [];
  for (const profile of profiles) {
    const similarity = cosineSimilarity(embeddingResult.embedding, profile.profile.vector);
    ranked.push({ ...profile, similarity });
  }
  ranked.sort((a, b) => b.similarity - a.similarity);
  const matched = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  const margin = matched && runnerUp ? matched.similarity - runnerUp.similarity : (matched ? matched.similarity : 0);
  const SPEAKER_MATCH_MIN_MARGIN = 0.06;

  if (matched && matched.similarity >= SPEAKER_EMBEDDING_THRESHOLD) {
    // 第一第二太接近 → 模糊不分配，不强行归人
    if (runnerUp && runnerUp.similarity >= SPEAKER_EMBEDDING_THRESHOLD && margin < SPEAKER_MATCH_MIN_MARGIN) {
      return null; // 待识别，交会后聚类归集
    }
    const merged = mergeEmbeddingVector(matched.profile.vector, embeddingResult.embedding, matched.sampleCount);
    await bumpProfileFeatures(null, matched.id, JSON.stringify({ kind: "embedding", vector: merged }), new Date().toISOString());
    return {
      speaker: matched.label,
      confidence: Math.max(55, Math.min(99, Math.round(matched.similarity * 100))),
      source: "embedding",
    };
  }

  if (profiles.length > 0) {
    const candidate = matchEmbeddingProfile(candidates, embeddingResult.embedding);
    if (candidate && candidate.similarity >= SPEAKER_CANDIDATE_THRESHOLD) {
      const nextCount = Number(candidate.sampleCount || 1) + 1;
      const merged = mergeEmbeddingVector(candidate.profile.vector, embeddingResult.embedding, candidate.sampleCount);
      if (nextCount >= SPEAKER_CANDIDATE_PROMOTE_COUNT) {
        const label = await getNextSpeakerLabel(null, meetingId);
        await renameProfileLabel(null, meetingId, candidate.label, label, new Date().toISOString());
        await setProfileFeatures(null, candidate.id, JSON.stringify({ kind: "embedding", vector: merged }), nextCount, new Date().toISOString());
        return {
          speaker: label,
          confidence: Math.max(60, Math.min(92, Math.round(candidate.similarity * 100))),
          source: "embedding",
        };
      }
      await setProfileFeatures(null, candidate.id, JSON.stringify({ kind: "embedding_candidate", vector: merged }), nextCount, new Date().toISOString());
      return {
        speaker: "待识别",
        confidence: Math.max(0, Math.min(54, Math.round(candidate.similarity * 100))),
        source: "pending",
      };
    }

    await insertProfile(
      null,
      meetingId,
      `__candidate_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      JSON.stringify({ kind: "embedding_candidate", vector: normalizeVector(embeddingResult.embedding) }),
      1,
      new Date().toISOString(),
    );
    return {
      speaker: "待识别",
      confidence: Math.max(0, Math.min(54, Math.round((matched?.similarity || 0) * 100))),
      source: "pending",
    };
  }

  const label = await getNextSpeakerLabel(null, meetingId);
  await insertProfile(
    null,
    meetingId,
    label,
    JSON.stringify({ kind: "embedding", vector: normalizeVector(embeddingResult.embedding) }),
    1,
    new Date().toISOString(),
  );
  return {
    speaker: label,
    confidence: 65,
    source: "embedding",
  };
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
    if (!response.ok) return null;
    const payload = JSON.parse(response.text);
    if (payload?.error) return null;
    const embeddings = Array.isArray(payload?.embeddings) ? payload.embeddings : [];
    const best = embeddings
      .filter((item) => Array.isArray(item?.embedding) && item.embedding.length)
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
    if (!best) return null;
    return {
      embedding: normalizeVector(best.embedding.map(Number)),
      confidence: Number(best.confidence || 0),
    };
  } catch {
    return null;
  }
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
