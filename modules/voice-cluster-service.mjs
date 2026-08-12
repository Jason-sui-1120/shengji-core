/**
 * voice-cluster-service.mjs —— 声纹聚类回填服务（纯业务逻辑，async）。
 * 只依赖 VoiceClusterStore 接口，不接触 openDb/方言 SQL/事务。
 * 迁移自 index.mjs 的 reconcileMeetingSpeakersByVoiceCluster。
 */
import fs from "node:fs";
import { hasAiAccess } from "./speaker-core.mjs";
import { sliceWavBySeconds } from "./audio-utils.mjs";
import {
  buildVoiceWindows, clusterVoiceEmbeddings, cosineSimilarity as voiceCosineSimilarity,
} from "./voice-cluster.mjs";

/**
 * VoiceClusterService：声纹聚类回填服务。
 * 依赖注入 VoiceClusterStore（SQLite/MySQL 各自实现）+ AI 调用（extractSpeakerEmbedding）。
 * 业务逻辑两端共用。
 */
export class VoiceClusterService {
  constructor(store, aiCalls = {}) {
    this.store = store;
    this.extractSpeakerEmbedding = aiCalls.extractSpeakerEmbedding;
    this.resolveMeetingSpeakerTracks = typeof aiCalls.resolveMeetingSpeakerTracks === "function"
      ? aiCalls.resolveMeetingSpeakerTracks
      : null;
    // 旧链路副作用注入（快照刷新/自动分析调度），默认空操作。
    this.afterVoiceCluster = typeof aiCalls.afterVoiceCluster === "function"
      ? aiCalls.afterVoiceCluster
      : async () => {};
  }

  /**
   * 声纹聚类回填主流程（迁移 reconcileMeetingSpeakersByVoiceCluster）。
   * 从稳定转写切语音块 → 提取声纹 → 会议内聚类 → 碎片过滤 → 生成轮次 → 回填数据库。
   */
  async reconcileByVoiceCluster(meetingId, options = {}) {
    const key = Number(meetingId || 0);
    const source = await this.store.getMeetingSourceAudioInfo(key);
    if (!source?.audioPath || !fs.existsSync(source.audioPath)) {
      return { ok: false, meetingId: key, reason: "source_audio_unavailable" };
    }
    if (!hasAiAccess()) return { ok: false, meetingId: key, reason: "ai_unavailable" };
    const wav = fs.readFileSync(source.audioPath);

    // 1. 从稳定转写取词级时间戳（按段近似为词边界，足够切语音块）
    const stableRows = await this.store.listStableTranscriptRows(key);
    if (!stableRows.length) return { ok: false, meetingId: key, reason: "no_stable_transcripts" };

    const words = [];
    for (const row of stableRows) {
      const start = Number(row.audioStartMs || 0) / 1000;
      const end = Number(row.audioEndMs || 0) / 1000;
      if (end > start) words.push({ startSeconds: start, endSeconds: end, text: String(row.text || "") });
    }

    // 2. 切语音块（1.2-5.5s）
    const windows = buildVoiceWindows(words, {
      minSeconds: 1.2, targetSeconds: 3.2, maxSeconds: 5.5, maxGapSeconds: 0.65,
    });
    if (windows.length < 4) return { ok: false, meetingId: key, reason: "insufficient_voice_windows", windowCount: windows.length };

    // 3. 逐块提取声纹（并发 4 路）
    const maxSamples = Math.max(12, Number(options.maxSamples || 400));
    const sampled = windows.length <= maxSamples
      ? windows
      : Array.from({ length: maxSamples }, (_, i) => windows[Math.min(windows.length - 1, Math.floor(i * windows.length / maxSamples))]);
    console.log(`[voice-cluster] meeting=${key} windows=${windows.length} sampled=${sampled.length} extracting embeddings...`);

    // 3a. 加载会议内已缓存的声纹
    const embeddingCache = await this.store.listVoiceEmbeddings(key);
    let cacheHits = 0;

    const samples = [];
    const newEmbeddings = [];
    const concurrency = 4;
    let batchIndex = 0;
    for (let i = 0; i < sampled.length; i += concurrency) {
      batchIndex += 1;
      const batch = sampled.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(async (win) => {
        const startMs = Math.round(win.startSeconds * 1000);
        const endMs = Math.round(win.endSeconds * 1000);
        const cacheKey = `${startMs}-${endMs}`;
        const cached = embeddingCache.get(cacheKey);
        if (cached?.length) {
          cacheHits += 1;
          return { startSeconds: win.startSeconds, endSeconds: win.endSeconds, text: win.text, vector: cached };
        }
        const clip = sliceWavBySeconds(wav, win.startSeconds, win.endSeconds);
        const emb = await this.extractSpeakerEmbedding(clip, key);
        if (emb?.embedding?.length) {
          newEmbeddings.push({ startMs, endMs, vector: emb.embedding });
          return { startSeconds: win.startSeconds, endSeconds: win.endSeconds, text: win.text, vector: emb.embedding };
        }
        return null;
      }));
      for (const r of results) if (r) samples.push(r);
      if (batchIndex % 10 === 0) console.log(`[voice-cluster] meeting=${key} progress ${samples.length}/${sampled.length} (cacheHits=${cacheHits})`);
    }

    // 3b. 新提取的向量批量写入缓存
    for (const e of newEmbeddings) {
      await this.store.insertVoiceEmbedding(key, e.startMs, e.endMs, e.vector);
    }
    console.log(`[voice-cluster] meeting=${key} embeddings done (${samples.length}), cacheHits=${cacheHits}, newSaved=${newEmbeddings.length}, clustering`);
    if (samples.length < 6) return { ok: false, meetingId: key, reason: "insufficient_embeddings", sampleCount: samples.length };

    // 4. 会议内聚类
    const clustered = clusterVoiceEmbeddings(samples, options.cluster || {});
    const accepted = clustered.assignments.filter((a) => a.accepted && a.clusterId !== "unknown");
    if (!accepted.length) return { ok: false, meetingId: key, reason: "no_accepted_clusters", sampleCount: samples.length };

    // 5. cluster → 说话人标签映射（碎片过滤：总时长≥30s 或 样本数≥4）
    const clusterStats = new Map();
    for (const a of accepted) {
      const stat = clusterStats.get(a.clusterId) || { seconds: 0, count: 0, vectors: [] };
      stat.seconds += a.endSeconds - a.startSeconds;
      stat.count += 1;
      stat.vectors.push(a.vector);
      clusterStats.set(a.clusterId, stat);
    }
    const minClusterSeconds = Number(options.minClusterSeconds ?? 30);
    const minClusterSamples = Number(options.minClusterSamples ?? 4);
    const bigClusters = new Set();
    for (const [cid, stat] of clusterStats) {
      if (stat.seconds >= minClusterSeconds || stat.count >= minClusterSamples) bigClusters.add(cid);
    }
    // 碎片归入最相似的大 cluster（质心相似度 ≥ 0.6）
    const clusterCentroid = new Map();
    for (const c of clustered.clusters) clusterCentroid.set(c.id, c.centroid);
    const reassign = new Map();
    for (const [cid] of clusterStats) {
      if (bigClusters.has(cid)) continue;
      let bestBig = null, bestSim = 0;
      for (const bigCid of bigClusters) {
        const sim = voiceCosineSimilarity(clusterCentroid.get(cid) || [], clusterCentroid.get(bigCid) || []);
        if (sim > bestSim) { bestSim = sim; bestBig = bigCid; }
      }
      reassign.set(cid, bestSim >= 0.6 ? bestBig : null);
    }
    const clusterFirstSeen = new Map();
    for (const a of accepted) {
      let effectiveCluster = a.clusterId;
      if (!bigClusters.has(a.clusterId)) {
        const target = reassign.get(a.clusterId);
        effectiveCluster = target || "unknown";
      }
      a.clusterId = effectiveCluster;
      if (effectiveCluster === "unknown") { a.accepted = false; continue; }
      if (!clusterFirstSeen.has(effectiveCluster)) clusterFirstSeen.set(effectiveCluster, a.startSeconds);
    }
    const orderedClusters = [...clusterFirstSeen.entries()].sort((a, b) => a[1] - b[1]);
    if (!this.resolveMeetingSpeakerTracks) {
      return { ok: false, meetingId: key, reason: "speaker_track_manager_unavailable" };
    }
    const trackAssignments = await this.resolveMeetingSpeakerTracks({
      meetingId: key,
      confirmNewTracks: true,
      observations: orderedClusters.map(([clusterId, firstSeen]) => {
        const stat = clusterStats.get(clusterId) || { seconds: 0, count: 1 };
        return {
          key: String(clusterId),
          embedding: clusterCentroid.get(clusterId) || [],
          durationMs: Math.round(Number(stat.seconds || 0) * 1000),
          evidenceCount: Number(stat.count || 1),
          startMs: Math.round(Number(firstSeen || 0) * 1000),
          source: "post_meeting_voice_cluster",
          confirmNewTrack: true,
        };
      }),
    });
    const labelByCluster = new Map((Array.isArray(trackAssignments) ? trackAssignments : [])
      .filter((item) => item?.status === "confirmed" && item?.speaker && item.speaker !== "待识别")
      .map((item) => [String(item.key), item.speaker]));
    if (!labelByCluster.size) return { ok: false, meetingId: key, reason: "speaker_tracks_unconfirmed" };

    // 6. 生成轮次
    const finalAccepted = accepted.filter((a) => a.accepted && a.clusterId !== "unknown");
    const turns = finalAccepted.map((a) => ({
      speaker: labelByCluster.get(a.clusterId) || "待识别",
      confidence: Math.round(Math.max(0, Math.min(1, a.similarity || 0.5)) * 100),
      startMs: Math.max(0, Math.round(a.startSeconds * 1000)),
      endMs: Math.max(1, Math.round(a.endSeconds * 1000)),
      overlapGroup: "",
    }));
    console.log(`[voice-cluster] meeting=${key} clusters=${clustered.clusters.length} big=${bigClusters.size} filtered=${clustered.clusters.length - bigClusters.size} speakers=${orderedClusters.length}`);

    // 7. 回填数据库（原子应用：删旧 turns + 插入新 turns + 更新 transcripts + bump revision）
    const rows = stableRows;
    const assignments = [];
    for (const row of rows) {
      if (row.userEdited || row.speakerSource === "manual") continue;
      let winner = null;
      let bestOverlap = 0;
      for (const turn of turns) {
        if (turn.speaker === "待识别") continue;
        const overlap = Math.max(0, Math.min(Number(row.audioEndMs || 0), turn.endMs) - Math.max(Number(row.audioStartMs || 0), turn.startMs));
        if (overlap > bestOverlap) { winner = turn; bestOverlap = overlap; }
      }
      if (winner && bestOverlap >= 250 && (row.speaker !== winner.speaker || row.speakerSource !== "post_meeting_voice_cluster")) assignments.push({ row, winner });
    }
    const applied = await this.store.applyVoiceClusterAssignments(key, { turns, assignments });

    // 旧链路副作用（快照刷新/自动分析调度）
    if (applied.updatedCount) {
      await this.afterVoiceCluster(key, applied.stableRevision);
    }

    return {
      ok: true,
      meetingId: key,
      method: "voice_cluster",
      windowCount: windows.length,
      sampleCount: samples.length,
      clusterCount: clustered.clusters.length,
      unknownCount: clustered.assignments.length - finalAccepted.length,
      speakerCount: new Set(turns.map((t) => t.speaker).filter((s) => s !== "待识别")).size,
      turnCount: turns.length,
      updatedCount: applied.updatedCount,
      stableRevision: applied.stableRevision,
    };
  }
}
