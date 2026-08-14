/**
 * 会议级说话人轨道管理器。
 *
 * 实时句子、45 秒窗口和会后聚类都只能提供“本次观察”，不能各自创建一套
 * 说话人编号。本模块把这些观察统一映射到 speaker_profiles 中的会议级轨道。
 *
 * 设计约束：
 * - 已确认轨道用普通 `说话人 N` 标签；短噪声只进入隐藏 candidate，不增加用户可见人数。
 * - 实时弱证据无法确认新说话人时，先沿用 fallbackLabel，并标记 provisional；后续强证据会纠正。
 * - 同一批优先一对一映射；若分离模型明显把同一人拆成两条，允许高相似轨道合并，避免人数膨胀。
 * - 与多个已有说话人都接近、无法拉开差距时只保留临时归属，不贸然新增可见说话人。
 * - 旧版 `{ kind: "embedding" }` 画像按 confirmed 兼容，避免升级后重新编号。
 */
import { cosineSimilarity, mergeEmbeddingVector, normalizeVector, safeParseJson } from "./speaker-utils.mjs";

const DEFAULTS = Object.freeze({
  matchThreshold: 0.55,
  duplicateReuseThreshold: 0.68,
  candidateThreshold: 0.62,
  minMargin: 0.06,
  strongObservationMs: 4_000,
  singleTurnStrongMs: 6_000,
  candidatePromoteCount: 3,
  maxHiddenCandidates: 8,
});

function clampConfidence(value) {
  return Math.max(0, Math.min(99, Math.round(Number(value || 0))));
}

function parseProfiles(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    profile: safeParseJson(row.featuresJson),
  }));
}

function isConfirmedProfile(row) {
  return row?.profile?.kind === "embedding" && Array.isArray(row.profile.vector);
}

function isCandidateProfile(row) {
  return row?.profile?.kind === "embedding_candidate" && Array.isArray(row.profile.vector);
}

function rankProfiles(profiles, embedding, excludedIds = new Set()) {
  return profiles
    .filter((profile) => !excludedIds.has(Number(profile.id)))
    .map((profile) => ({
      profile,
      similarity: cosineSimilarity(embedding, profile.profile.vector),
    }))
    .sort((left, right) => right.similarity - left.similarity);
}

function buildProfileJson(vector, previous = {}, patch = {}) {
  return JSON.stringify({
    kind: "embedding",
    vector: normalizeVector(vector),
    status: previous.status || "confirmed",
    totalSpeechMs: Math.max(0, Number(previous.totalSpeechMs || 0)),
    ...patch,
  });
}

function buildCandidateJson(vector, previous = {}, patch = {}) {
  return JSON.stringify({
    kind: "embedding_candidate",
    vector: normalizeVector(vector),
    status: "candidate",
    totalSpeechMs: Math.max(0, Number(previous.totalSpeechMs || 0)),
    ...patch,
  });
}

function provisionalFallback(confirmed, fallbackLabel) {
  const explicit = String(fallbackLabel || "").trim();
  if (explicit && explicit !== "待识别") return explicit;
  return String(confirmed.at(-1)?.label || confirmed[0]?.label || "说话人 1");
}

function canLearnConfirmedProfile(observation) {
  if (typeof observation?.allowProfileLearning === "boolean") {
    return observation.allowProfileLearning;
  }
  // 兼容旧调用方时只信任文件级/会后强证据。实时短片段仍可匹配并即时显示
  // 已有说话人，但不能反向改写已确认画像，否则咳嗽、串音和截断句会逐步
  // 把会议级声纹中心拖偏。
  return observation?.source === "rolling_diarization"
    || observation?.source === "post_meeting_voice_cluster";
}

/**
 * 创建一个使用端侧 speaker-store 的会议轨道管理器。
 * store 方法与现有 SQLite/MySQL speaker-store 契约一致。
 */
export function createMeetingSpeakerTrackManager(store, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  // 队列必须属于当前 store/端侧实例。若放在模块全局，测试或同进程内的多个
  // Adapter 会互相等待，甚至把一个存储中的画像状态带入另一个存储。
  const meetingQueues = new Map();

  async function resolveBatchNow({ meetingId, observations = [], fallbackLabel = "", confirmNewTracks = false }) {
    const key = Number(meetingId || 0);
    const usable = (Array.isArray(observations) ? observations : [])
      .filter((item) => Array.isArray(item?.embedding) && item.embedding.length)
      .map((item, index) => ({
        ...item,
        key: String(item.key ?? item.localTrackId ?? index),
        embedding: normalizeVector(item.embedding.map(Number)),
        durationMs: Math.max(0, Number(item.durationMs || 0)),
        longestContinuousMs: Math.max(0, Number(item.longestContinuousMs || 0)),
        evidenceCount: Math.max(1, Number(item.evidenceCount || 1)),
      }))
      .sort((left, right) => Number(left.startMs || 0) - Number(right.startMs || 0));
    if (!key || !usable.length) return [];

    const all = parseProfiles(await store.listProfiles(null, key));
    const confirmed = all.filter(isConfirmedProfile);
    const candidates = all.filter(isCandidateProfile);
    const usedConfirmedIds = new Set();
    const results = [];

    for (const observation of usable) {
      const allRanked = rankProfiles(confirmed, observation.embedding);
      const allWinner = allRanked[0] || null;
      const allRunnerUp = allRanked[1] || null;
      const allMargin = allWinner && allRunnerUp
        ? allWinner.similarity - allRunnerUp.similarity
        : (allWinner ? allWinner.similarity : 0);
      const ranked = rankProfiles(confirmed, observation.embedding, usedConfirmedIds);
      const winner = ranked[0] || null;
      const runnerUp = ranked[1] || null;
      const margin = winner && runnerUp ? winner.similarity - runnerUp.similarity : (winner ? winner.similarity : 0);
      const clearMatch = Boolean(
        winner
        && winner.similarity >= settings.matchThreshold
        && (!runnerUp || runnerUp.similarity < settings.matchThreshold || margin >= settings.minMargin)
      );
      const duplicateReuse = Boolean(
        !clearMatch
        && allWinner
        && usedConfirmedIds.has(Number(allWinner.profile.id))
        && allWinner.similarity >= settings.duplicateReuseThreshold
        && (!allRunnerUp || allRunnerUp.similarity < settings.matchThreshold || allMargin >= settings.minMargin)
      );
      const matchedWinner = clearMatch ? winner : (duplicateReuse ? allWinner : null);

      if (matchedWinner) {
        const profile = matchedWinner.profile;
        if (canLearnConfirmedProfile(observation)) {
          const nextCount = Math.max(1, Number(profile.sampleCount || 1)) + 1;
          const merged = mergeEmbeddingVector(profile.profile.vector, observation.embedding, profile.sampleCount);
          const updatedProfileJson = buildProfileJson(merged, profile.profile, {
            status: "confirmed",
            totalSpeechMs: Number(profile.profile.totalSpeechMs || 0) + observation.durationMs,
            lastSource: observation.source || "embedding",
          });
          await store.setProfileFeatures(
            null,
            profile.id,
            updatedProfileJson,
            nextCount,
            new Date().toISOString(),
          );
          profile.profile = safeParseJson(updatedProfileJson);
          profile.sampleCount = nextCount;
        }
        usedConfirmedIds.add(Number(profile.id));
        results.push({
          key: observation.key,
          speaker: profile.label,
          confidence: clampConfidence(Math.max(55, matchedWinner.similarity * 100)),
          source: observation.source || "embedding",
          status: "confirmed",
          similarity: matchedWinner.similarity,
        });
        continue;
      }

      const ambiguousKnown = Boolean(
        allWinner
        && allRunnerUp
        && allWinner.similarity >= settings.matchThreshold
        && allRunnerUp.similarity >= settings.matchThreshold
        && allMargin < settings.minMargin
      );
      if (ambiguousKnown) {
        results.push({
          key: observation.key,
          speaker: provisionalFallback(confirmed, fallbackLabel),
          confidence: clampConfidence(Math.min(54, allWinner.similarity * 100)),
          source: "realtime_provisional",
          status: "provisional",
          similarity: allWinner.similarity,
        });
        continue;
      }

      const strongObservation = Boolean(
        confirmNewTracks
        || observation.confirmNewTrack
        || (
          observation.durationMs >= settings.strongObservationMs
          && (
            observation.evidenceCount >= 2
            || observation.longestContinuousMs >= settings.singleTurnStrongMs
          )
        )
      );
      const candidateRanked = rankProfiles(candidates, observation.embedding);
      const candidateWinner = candidateRanked[0] || null;
      if (candidateWinner && candidateWinner.similarity >= settings.candidateThreshold) {
        const candidate = candidateWinner.profile;
        // 实时弱声纹只用于当前界面的临时归属，不能累计隐藏候选、晋升正式轨道，
        // 否则同一人的连续实时短句会在可靠的 45 秒分离结果到来前制造新人。
        // 文件分离或会后聚类等强观察仍可接管该候选并完成晋升。
        if (!canLearnConfirmedProfile(observation)) {
          results.push({
            key: observation.key,
            speaker: provisionalFallback(confirmed, fallbackLabel),
            confidence: clampConfidence(Math.min(54, candidateWinner.similarity * 100)),
            source: "realtime_provisional",
            status: "provisional",
            similarity: candidateWinner.similarity,
          });
          continue;
        }
        const nextCount = Math.max(1, Number(candidate.sampleCount || 1)) + 1;
        const merged = mergeEmbeddingVector(candidate.profile.vector, observation.embedding, candidate.sampleCount);
        const totalSpeechMs = Number(candidate.profile.totalSpeechMs || 0) + observation.durationMs;
        const promote = strongObservation || nextCount >= settings.candidatePromoteCount || totalSpeechMs >= settings.strongObservationMs * 2;
        if (promote) {
          const label = await store.getNextSpeakerLabel(null, key);
          await store.renameProfileLabel(null, key, candidate.label, label, new Date().toISOString());
          await store.setProfileFeatures(
            null,
            candidate.id,
            buildProfileJson(merged, candidate.profile, {
              status: "confirmed",
              totalSpeechMs,
              lastSource: observation.source || "embedding",
            }),
            nextCount,
            new Date().toISOString(),
          );
          candidate.label = label;
          candidate.profile = { kind: "embedding", vector: merged, status: "confirmed", totalSpeechMs };
          candidate.sampleCount = nextCount;
          confirmed.push(candidate);
          usedConfirmedIds.add(Number(candidate.id));
          results.push({
            key: observation.key,
            speaker: label,
            confidence: clampConfidence(Math.max(60, candidateWinner.similarity * 100)),
            source: observation.source || "embedding",
            status: "confirmed",
            similarity: candidateWinner.similarity,
          });
        } else {
          await store.setProfileFeatures(
            null,
            candidate.id,
            buildCandidateJson(merged, candidate.profile, { totalSpeechMs }),
            nextCount,
            new Date().toISOString(),
          );
          results.push({
            key: observation.key,
            speaker: provisionalFallback(confirmed, fallbackLabel),
            confidence: clampConfidence(Math.min(54, candidateWinner.similarity * 100)),
            source: "realtime_provisional",
            status: "provisional",
            similarity: candidateWinner.similarity,
          });
        }
        continue;
      }

      // 只有强证据才能正式占用“说话人 N”编号。实时短句仍立即返回
      // provisionalFallback（首条即“说话人 1”），但先积累成隐藏候选；否则开场
      // 1~2 秒的数字、噪声或截断片段会污染首条画像，后续 45 秒可靠声纹只能被
      // 错误地新建成“说话人 2”，造成单人会议显示两个人。
      if (strongObservation) {
        const label = await store.getNextSpeakerLabel(null, key);
        const profileJson = buildProfileJson(observation.embedding, {}, {
          status: "confirmed",
          totalSpeechMs: observation.durationMs,
          lastSource: observation.source || "embedding",
        });
        const inserted = await store.insertProfile(null, key, label, profileJson, 1, new Date().toISOString());
        const created = {
          id: Number(inserted?.id || -(confirmed.length + 1)),
          label,
          featuresJson: profileJson,
          sampleCount: 1,
          profile: safeParseJson(profileJson),
        };
        confirmed.push(created);
        usedConfirmedIds.add(created.id);
        results.push({
          key: observation.key,
          speaker: label,
          confidence: clampConfidence(observation.confidence || 65),
          source: observation.source || "embedding",
          status: "confirmed",
          similarity: winner?.similarity || 0,
        });
        continue;
      }

      // 弱、短、孤立的观察不增加可见人数，只积累成隐藏候选。
      if (candidates.length >= settings.maxHiddenCandidates && typeof store.deleteProfileById === "function") {
        const stale = candidates.shift();
        if (stale?.id) await store.deleteProfileById(null, stale.id);
      }
      const candidateLabel = `__candidate_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const profileJson = buildCandidateJson(observation.embedding, {}, { totalSpeechMs: observation.durationMs });
      const inserted = await store.insertProfile(null, key, candidateLabel, profileJson, 1, new Date().toISOString());
      candidates.push({
        id: Number(inserted?.id || -(candidates.length + 1)),
        label: candidateLabel,
        featuresJson: profileJson,
        sampleCount: 1,
        profile: safeParseJson(profileJson),
      });
      results.push({
        key: observation.key,
        speaker: provisionalFallback(confirmed, fallbackLabel),
        confidence: clampConfidence(Math.min(40, Math.max(20, (winner?.similarity || 0) * 100))),
        source: "realtime_provisional",
        status: "provisional",
        similarity: winner?.similarity || 0,
      });
    }
    return results;
  }

  return {
    resolveBatch(params) {
      const key = Number(params?.meetingId || 0);
      const previous = meetingQueues.get(key) || Promise.resolve();
      const task = previous.catch(() => undefined).then(() => resolveBatchNow(params));
      meetingQueues.set(key, task);
      void task.finally(() => {
        if (meetingQueues.get(key) === task) meetingQueues.delete(key);
      });
      return task;
    },
  };
}

export { DEFAULTS as MEETING_SPEAKER_TRACK_DEFAULTS };
