/**
 * 尾段稳定化共享核心。
 *
 * 不依赖 SQLite、MySQL、网关或具体 ASR 模型；两端仅通过注入的存储操作适配。
 * 这里的规则必须保持一致：任一文件 ASR 请求有界，遗留的 stabilizing 状态必须
 * 能以实时稿兜底收口，不能无限阻塞会议结束。
 */
export const DEFAULT_FILE_ASR_REQUEST_TIMEOUT_MS = 25_000;

export async function fetchWithDeadline(stage, url, options, {
  deadline,
  requestTimeoutMs = DEFAULT_FILE_ASR_REQUEST_TIMEOUT_MS,
} = {}) {
  const remainingMs = Math.max(0, Number(deadline) - Date.now());
  if (remainingMs < 1) throw new Error(`file ASR timed out before ${stage}`);
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(1, Number(requestTimeoutMs) || DEFAULT_FILE_ASR_REQUEST_TIMEOUT_MS), remainingMs);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`file ASR ${stage} request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通过存储适配器恢复“已无执行上下文”的尾段校准。
 * listStale 接收 ISO 截止时间并返回 meetingId 数组；不会触碰录音，只将未稳定稿
 * 标为 fallback stable，再解除最终纪要的状态门禁。
 */
export async function recoverStaleTailStabilizations({
  listStale,
  forceStabilize,
  markComplete,
  staleAfterMs = 5 * 60_000,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (typeof listStale !== "function" || typeof forceStabilize !== "function" || typeof markComplete !== "function") {
    throw new Error("tail stabilization recovery adapter is incomplete");
  }
  const staleBefore = new Date(Number(now()) - Math.max(0, Number(staleAfterMs) || 0)).toISOString();
  const meetingIds = await listStale(staleBefore);
  const recovered = [];
  for (const rawId of meetingIds || []) {
    const meetingId = Number(rawId);
    if (!Number.isFinite(meetingId) || meetingId <= 0) continue;
    const fallbackCount = await forceStabilize(meetingId);
    await markComplete(meetingId);
    recovered.push({ meetingId, fallbackCount: Number(fallbackCount || 0) });
    log(`[stable-asr] recovered stale tail meeting=${meetingId} fallbackCount=${Number(fallbackCount || 0)}`);
  }
  return recovered;
}
