/**
 * finalize-ai-jobs.mjs —— 会后归档 AI 任务跟踪（两端共用）。
 * 跟踪会议级 AI 任务（滚动 ASR/声纹富化），归档前等待完成。
 * 无 DB 依赖的纯状态管理。
 */

const meetingAiJobState = new Map();

export function beginMeetingAiJob(meetingId) {
  const key = Number(meetingId || 0);
  const state = meetingAiJobState.get(key) || { active: 0, waiters: [] };
  state.active += 1;
  meetingAiJobState.set(key, state);
}

export function endMeetingAiJob(meetingId) {
  const key = Number(meetingId || 0);
  const state = meetingAiJobState.get(key);
  if (!state) return;
  state.active = Math.max(0, state.active - 1);
  const ready = state.waiters.filter((waiter) => state.active <= waiter.maxActive);
  state.waiters = state.waiters.filter((waiter) => state.active > waiter.maxActive);
  for (const waiter of ready) waiter.resolve(true);
  if (state.active === 0) meetingAiJobState.delete(key);
}

export async function waitForMeetingAiJobs(meetingId, timeoutMs, maxActive = 0) {
  const key = Number(meetingId || 0);
  const state = meetingAiJobState.get(key);
  const normalizedMaxActive = Math.max(0, Number(maxActive || 0));
  if (!state || state.active <= normalizedMaxActive) return true;
  return new Promise((resolve) => {
    const waiter = {
      maxActive: normalizedMaxActive,
      resolve: (ok) => {
        clearTimeout(timer);
        resolve(ok);
      },
    };
    const timer = setTimeout(() => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      resolve(false);
    }, Math.max(1_000, Number(timeoutMs || 0)));
    state.waiters.push(waiter);
  });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
