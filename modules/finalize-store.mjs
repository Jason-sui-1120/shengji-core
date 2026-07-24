/**
 * finalize-store.mjs —— 会后归档的 DB adapter 接口（两端各自实现）。
 * FinalizeService 不接触 SQL/事务，所有 DB 操作通过本接口。
 */

export const FINALIZE_STORE_METHODS = [
  "getMeetingWithProject",        // 查询会议+项目信息
  "getMeetingTranscripts",        // 查询会议稳定转写行
  "getMeetingSummaryBlocks",      // 查询实时总结块
  "getMeetingActions",            // 查询待办
  "getProjectHistoricalContext",  // 查询项目历史上下文
  "saveFinalizedMeeting",         // 保存归档纪要
  "recordAnalysisRun",            // 记录分析运行
  "getFinalizationGate",          // 权限门控（公司端，公网端返回 ok）
];

export function assertFinalizeStore(store) {
  for (const method of FINALIZE_STORE_METHODS) {
    if (typeof store?.[method] !== "function") {
      throw new Error(`FinalizeStore 缺少方法: ${method}`);
    }
  }
  return store;
}
