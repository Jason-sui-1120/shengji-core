/**
 * finalize-service.mjs —— 会后归档服务（纯业务逻辑，async）。
 * 只依赖 FinalizeStore 接口 + AI 调用注入，不接触 openDb/方言 SQL/事务。
 * 迁移自两端 finalizeMeetingInner 的共同核心。
 * normalizeFinalMinutes/parseJsonContent 由调用方处理（在 finalize-evidence 或调用方注入）。
 */
import { hasAiAccess } from "./speaker-core.mjs";
import { delay, waitForMeetingAiJobs } from "./finalize-ai-jobs.mjs";
import { buildFinalTranscriptEvidence } from "./finalize-evidence.mjs";
import { AIT_FINAL_MODEL, ROLLING_ASR_TIMEOUT_MS } from "./config.mjs";

/**
 * FinalizeService：会后归档服务。
 * 依赖注入 FinalizeStore（SQLite/MySQL 各自实现）+ AI 调用（callFinalMinutes）。
 * 业务逻辑两端共用。
 */
export class FinalizeService {
  constructor(store, aiCalls = {}) {
    this.store = store;
    // 允许调用方覆盖 store 的复杂方法（getProjectHistoricalContext/saveFinalizedMeeting
    // 依赖项目记忆/纪要存储链路，由 index.mjs 注入真实实现）。
    if (typeof aiCalls.getProjectHistoricalContext === "function") {
      this.store.getProjectHistoricalContext = aiCalls.getProjectHistoricalContext;
    }
    if (typeof aiCalls.saveFinalizedMeeting === "function") {
      this.store.saveFinalizedMeeting = aiCalls.saveFinalizedMeeting;
    }
    this.callFinalMinutes = aiCalls.callFinalMinutes;
    this.callChatCompletion = aiCalls.callChatCompletion;
    this.parseJsonContent = aiCalls.parseJsonContent;
    this.ensurePostMeetingTranscriptCoverage = aiCalls.ensurePostMeetingTranscriptCoverage;
    this.reconcileMeetingSpeakerTrack = aiCalls.reconcileMeetingSpeakerTrack || (async () => ({}));
  }

  /**
   * 会后归档主流程（迁移 finalizeMeetingInner 共同核心）。
   * 归档等待 → 覆盖补齐 → 数据获取 → 分块证据 → 纪要生成 → 保存。
   */
  async finalizeMeeting(meetingId, options = { save: true }) {
    const startedAt = Date.now();
    if (!hasAiAccess()) {
      return { ok: false, message: "AI gateway or AIT_API_KEY is not configured" };
    }
    const finalizeModel = options.model || AIT_FINAL_MODEL;

    // 权限门控（公司端有多用户权限检查，公网端返回 ok）
    const gate = await this.store.getFinalizationGate(meetingId);
    if (!gate.ok) return { ok: false, message: gate.message };

    // 归档前等待会议级 AI 任务完成（滚动 ASR/声纹富化）
    await delay(500);
    const sealed = await waitForMeetingAiJobs(meetingId, ROLLING_ASR_TIMEOUT_MS * 2 + 30_000);
    if (!sealed) return { ok: false, message: "会议转写仍在校准，请稍后重试生成最终纪要" };

    // 覆盖补齐（检查完整录音时间轴缺口，必要时补跑文件 ASR）
    let coverageAudit = null;
    if (options.save !== false) {
      coverageAudit = await this.ensurePostMeetingTranscriptCoverage(meetingId);
      if (!coverageAudit.ok) {
        await this.store.recordAnalysisRun({
          meetingId,
          model: finalizeModel,
          triggerType: "finalize_coverage",
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: String(coverageAudit.message || "完整录音覆盖校准失败").slice(0, 500),
        });
        return { ok: false, model: finalizeModel, coverageAudit, message: coverageAudit.message };
      }
      // 补跑文件稿会异步触发说话人分离；最终纪要必须等局部说话人更新完成。
      const speakersSealed = await waitForMeetingAiJobs(meetingId, ROLLING_ASR_TIMEOUT_MS * 2 + 30_000);
      if (!speakersSealed) return { ok: false, message: "会议说话人仍在校准，请稍后重试生成最终纪要", coverageAudit };
    }

    // 数据获取
    const meeting = await this.store.getMeetingWithProject(meetingId);
    if (!meeting) return { ok: false, message: "meeting not found" };
    const transcripts = await this.store.getMeetingTranscripts(meetingId);
    const summaryBlocks = await this.store.getMeetingSummaryBlocks(meetingId);
    const actions = await this.store.getMeetingActions(meetingId);
    const historicalContext = await this.store.getProjectHistoricalContext(meeting);

    // 分块证据（长会议不丢前半场）
    let transcriptEvidence;
    try {
      transcriptEvidence = await buildFinalTranscriptEvidence(transcripts, finalizeModel, {
        callChatCompletion: this.callChatCompletion,
        parseJsonContent: this.parseJsonContent,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.recordAnalysisRun({
        meetingId, model: finalizeModel, triggerType: "finalize", status: "failed",
        durationMs: Date.now() - startedAt, sourceRevision: Number(meeting.stableRevision || 0),
        error: message.slice(0, 500),
      });
      return { ok: false, model: finalizeModel, message };
    }

    // 纪要生成（callFinalMinutes 由调用方注入，含 prompt 构建）
    const finalMinutes = await this.callFinalMinutes({
      meeting,
      transcripts,
      summaryBlocks,
      actions,
      historicalContext,
      transcriptEvidence,
      finalizeModel,
    });
    if (!finalMinutes.ok) return finalMinutes;

    // 保存归档纪要
    const saved = options.save ? await this.store.saveFinalizedMeeting(meeting, finalMinutes.data, transcripts.length, finalizeModel) : null;
    await this.store.recordAnalysisRun({
      meetingId, model: finalizeModel, triggerType: "finalize", status: "success",
      durationMs: Date.now() - startedAt, sourceRevision: Number(meeting.stableRevision || 0),
    });

    return {
      ok: true,
      model: finalizeModel,
      coverageAudit,
      finalMinutes: finalMinutes.data,
      saved,
      transcriptCount: transcripts.length,
      durationMs: Date.now() - startedAt,
    };
  }
}
