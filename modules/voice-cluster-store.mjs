/**
 * voice-cluster-store.mjs —— 声纹聚类回填的 DB adapter 接口（两端各自实现）。
 * 与 RollingStore 同模式：业务逻辑（VoiceClusterService）不接触 SQL/事务，
 * 所有 DB 操作通过本接口，方言封装在各自实现内。
 */

export const VOICE_CLUSTER_STORE_METHODS = [
  "listStableTranscriptRows",      // 查询稳定转写行（用于切语音块和回填）
  "listVoiceEmbeddings",           // 查询会议内已缓存的声纹向量
  "insertVoiceEmbedding",          // 缓存一条声纹向量
  "applyVoiceClusterAssignments",  // 原子应用声纹聚类结果（删旧 turns + 插入新 turns + 更新 transcripts + bump revision）
  "getMeetingSourceAudioInfo",     // 查询源音频信息（复用 RollingStore 语义）
];

export function assertVoiceClusterStore(store) {
  for (const method of VOICE_CLUSTER_STORE_METHODS) {
    if (typeof store?.[method] !== "function") {
      throw new Error(`VoiceClusterStore 缺少方法: ${method}`);
    }
  }
  return store;
}
