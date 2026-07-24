/**
 * rolling-store.mjs —— RollingStore 接口定义（语义化，不暴露 SQL/事务/方言）。
 *
 * RollingTranscriptService 只依赖这个接口；SQLite 和 MySQL 各自实现。
 * 复杂事务、PRAGMA、批量更新、分行逻辑封装在各自实现内，接口只暴露业务语义。
 * 所有方法返回 Promise（SQLite 内部可同步执行，但对外统一 Promise）。
 */

/**
 * @typedef {Object} AsrWindowRun
 * @property {number} id
 * @property {number} meetingId
 * @property {string} model
 * @property {number} windowStartMs
 * @property {number} windowEndMs
 * @property {number} trimLeadingMs
 * @property {number} trimTrailingMs
 * @property {string} submissionMode
 * @property {string} status - 'transcribed' | 'applied'
 * @property {string} rawText
 * @property {string} resultJson
 */

/**
 * @typedef {Object} TranscriptRow
 * @property {number} id
 * @property {string} time
 * @property {string} speaker
 * @property {string} text
 * @property {string} rawText
 * @property {number} audioStartMs
 * @property {number} audioEndMs
 * @property {boolean} userEdited
 * @property {string} speakerSource
 * @property {string} stabilityStatus
 */

/**
 * RollingStore 接口（实现类需提供以下全部方法）：
 *
 * createWindowRun(meetingId, fields): Promise<number>
 *   创建窗口审计记录（transcribed 状态），返回 windowRunId。
 *
 * finalizeWindowRun(windowRunId, alignmentMode, updatedCount, compositionTrace): Promise<void>
 *   完成窗口审计（置 applied 状态）。
 *
 * listWindowTranscriptRows(meetingId, startMs, endMs, startId, endId): Promise<TranscriptRow[]>
 *   查询窗口内待校准转写行。
 *
 * getPreviousStableText(meetingId, beforeMs): Promise<string>
 *   查询窗口前 3 条 stable 文本（拼接，用于对齐上下文）。
 *
 * applyStableCorrection(meetingId, rows, correction, speakerUpdates): Promise<{ updatedCount, stableRevision }>
 *   原子应用稳定稿校正：批量更新行文本/时间轴/说话人，标记 stable，提升 revision。
 *   事务封装在实现内。
 *
 * insertFileAsrStableSegments(meetingId, segments, window): Promise<{ insertedCount, insertedIds }>
 *   原子插入文件 ASR 稳定片段（含重叠保护）。事务封装在实现内。
 *
 * applySpeakerEnrichment(meetingId, transcriptIds, assignments, splitPlans): Promise<{ updatedCount, splitRowCount, insertedRowCount }>
 *   原子应用说话人富化（含分行逻辑）。事务封装在实现内。
 *
 * getMeetingSourceAudioInfo(meetingId): Promise<{ audioPath, audioBytes, durationMs, status } | null>
 *   会议源音频信息。
 *
 * getLatestTranscriptId(meetingId): Promise<number>
 *   最新转写 id。
 */

// 接口占位（运行时校验实现完整性）
export const ROLLING_STORE_METHODS = [
  "createWindowRun",
  "finalizeWindowRun",
  "listWindowTranscriptRows",
  "getPreviousStableText",
  "applyStableCorrection",
  "insertFileAsrStableSegments",
  "deleteWindowTranscriptRows",
  "applySpeakerEnrichment",
  "getMeetingSourceAudioInfo",
  "getLatestTranscriptId",
];

export function assertRollingStore(store) {
  for (const method of ROLLING_STORE_METHODS) {
    if (typeof store[method] !== "function") {
      throw new Error(`RollingStore 实现缺少方法: ${method}`);
    }
  }
  return store;
}
