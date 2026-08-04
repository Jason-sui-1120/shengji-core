// core 共享：会后纪要归一化 + 待办候选去重合并
// 从两端 index.mjs 整体下沉（纯函数族谱），统一 normalizeFinalMinutes 严格证据过滤策略
// 依赖：evidence-utils.mjs（证据校验）、action-owner-evidence.mjs（负责人校验）、file-segments.mjs（getCharOverlapRatio）

import {
  extractTranscriptIdsFromEvidence,
  isTextGroundedByTranscripts,
  isEvidenceBackedByTranscript,
  hasExplicitDecisionEvidence,
  isExplicitlyConfirmedAction,
} from "./evidence-utils.mjs";
import { validateActionOwnerFromEvidence } from "./action-owner-evidence.mjs";
import { getCharOverlapRatio } from "./file-segments.mjs";

// ============ 待办候选归一化与去重 ============

export function normalizeActionTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[，。、“”‘’：:；;（）()\s]/g, "")
    .replace(/待确认|相关|事项|进行|推进|完成|一下|并/g, "")
    .slice(0, 60);
}

export function areSimilarActionTitles(a, b) {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aChars = new Set([...a]);
  const bChars = new Set([...b]);
  let overlap = 0;
  for (const char of aChars) {
    if (bChars.has(char)) overlap += 1;
  }
  const shorter = Math.min(aChars.size, bChars.size);
  return shorter >= 6 && overlap / shorter >= 0.72;
}

export function getActionObjectKey(title) {
  return normalizeActionTitle(title)
    .replace(/^(确认|评估|梳理|整理|推进|跟进|完成|验证|测试|开发|输出|同步|发送|更新|对齐|解决|关闭|补充|新增)/, "")
    .slice(0, 40);
}

export function getActionVerbKey(title) {
  const match = String(title || "").match(/(确认|评估|梳理|整理|推进|跟进|完成|验证|测试|开发|输出|同步|发送|更新|对齐|解决|关闭|补充|新增)/);
  return match?.[1] || "";
}

export function normalizeActionStatus(status, fallback = "candidate") {
  return ["candidate", "clarify", "confirmed", "in_progress", "done", "cancelled"].includes(status) ? status : fallback;
}

export function normalizeActionCandidateFields(action) {
  return {
    ...action,
    title: String(action.title || "").trim(),
    owner: action.owner || "待确认",
    due: action.due || "待确认",
    status: normalizeActionStatus(action.status, "candidate"),
    confidence: Math.max(0, Math.min(100, Number(action.confidence || 70))),
    source: action.source || "",
  };
}

export function scoreActionCandidate(action) {
  let score = Number(action.confidence || 0);
  if (action.owner && action.owner !== "待确认") score += 15;
  if (action.due && action.due !== "待确认") score += 15;
  score += Math.min(String(action.title || "").length, 40) / 4;
  return score;
}

export function pickStrongerActionStatus(a, b) {
  const order = ["clarify", "candidate", "confirmed", "in_progress", "done", "cancelled"];
  const aIndex = order.indexOf(a);
  const bIndex = order.indexOf(b);
  if (aIndex === -1) return b || "candidate";
  if (bIndex === -1) return a || "candidate";
  return bIndex > aIndex ? b : a;
}

export function stripContextPrefix(value) {
  let text = String(value || "").trim();
  for (let index = 0; index < 3; index += 1) {
    const next = text.replace(/^(历史延续|历史更新|历史关闭|本次新增)[：:]\s*/, "").trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

export function mergeActionSources(a, b) {
  const first = String(a || "").trim();
  const second = String(b || "").trim();
  if (!first) return second;
  if (!second || first === second || stripContextPrefix(first).includes(stripContextPrefix(second))) return first;
  if (stripContextPrefix(second).includes(stripContextPrefix(first))) return second;
  return `${first}；${stripContextPrefix(second)}`.slice(0, 360);
}

export function mergeActionCandidate(current, incoming) {
  const normalizedIncoming = normalizeActionCandidateFields(incoming);
  const winner = scoreActionCandidate(normalizedIncoming) > scoreActionCandidate(current) ? normalizedIncoming : current;
  const other = winner === current ? normalizedIncoming : current;
  return {
    ...winner,
    owner: winner.owner && winner.owner !== "待确认" ? winner.owner : other.owner || "待确认",
    due: winner.due && winner.due !== "待确认" ? winner.due : other.due || "待确认",
    status: pickStrongerActionStatus(winner.status, other.status),
    confidence: Math.max(Number(winner.confidence || 0), Number(other.confidence || 0)),
    source: mergeActionSources(winner.source, other.source),
  };
}

export function areSimilarActionCandidates(a, b) {
  const aTitle = normalizeActionTitle(a?.title);
  const bTitle = normalizeActionTitle(b?.title);
  if (areSimilarActionTitles(aTitle, bTitle)) return true;
  const aEvidenceIds = new Set(extractTranscriptIdsFromEvidence([a?.source]));
  const bEvidenceIds = extractTranscriptIdsFromEvidence([b?.source]);
  const sharesEvidence = bEvidenceIds.some((id) => aEvidenceIds.has(id));
  // 同一原文证据经常被模型改写成“一条短任务 + 一条包含该任务的长任务”。
  // 普通标题仍保持较高阈值；只有共享证据时才允许用较宽松的包含度合并，
  // 避免同一句话里的两个无关动作被误吞。
  if (sharesEvidence && getCharOverlapRatio(aTitle, bTitle) >= 0.58) return true;
  const aObject = getActionObjectKey(a?.title);
  const bObject = getActionObjectKey(b?.title);
  if (aObject && bObject && areSimilarActionTitles(aObject, bObject)) {
    const aVerb = getActionVerbKey(a?.title);
    const bVerb = getActionVerbKey(b?.title);
    return !aVerb || !bVerb || aVerb === bVerb || getCharOverlapRatio(aVerb, bVerb) >= 0.5;
  }
  return false;
}

export function dedupeActionCandidates(candidates) {
  const result = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate?.title) continue;
    const key = normalizeActionTitle(candidate.title);
    if (!key) continue;
    const duplicateIndex = result.findIndex((item) => areSimilarActionCandidates(candidate, item));
    if (duplicateIndex === -1) {
      result.push(normalizeActionCandidateFields(candidate));
      continue;
    }
    const current = result[duplicateIndex];
    result[duplicateIndex] = mergeActionCandidate(current, candidate);
  }
  return result.slice(0, 8);
}

export function ensureContextPrefix(value) {
  const text = String(value || "").trim();
  if (!text) return "本次新增：AI 分析生成";
  if (/^(历史延续|历史更新|历史关闭|本次新增)[：:]/.test(text)) return text;
  return `本次新增：${text}`;
}

export function stripEvidenceTags(value) {
  return String(value || "").replace(/\s*\[T\d+\]\s*/g, "").trim();
}

// ============ 项目记忆归一化 ============

export function normalizeMemoryItems(items, limit = 20) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit);
}

export function normalizeProjectMemoryDraft(memory, finalMinutes = {}) {
  const topics = Array.isArray(memory?.topics) && memory.topics.length
    ? memory.topics
    : Array.isArray(finalMinutes?.topics)
      ? finalMinutes.topics.map((topic) => topic?.title).filter(Boolean)
      : [];
  return {
    overview: String(memory?.overview || "").trim().slice(0, 260),
    stage: String(memory?.stage || "").slice(0, 40),
    facts: normalizeMemoryItems(memory?.facts, 12),
    goals: normalizeMemoryItems(memory?.goals, 12),
    topics: normalizeMemoryItems(topics, 20),
    decisions: normalizeMemoryItems(memory?.decisions?.length ? memory.decisions : finalMinutes?.decisions, 20),
    risks: normalizeMemoryItems(memory?.risks?.length ? memory.risks : finalMinutes?.risks, 20),
    openQuestions: normalizeMemoryItems(memory?.openQuestions?.length ? memory.openQuestions : finalMinutes?.openQuestions, 20),
    changes: normalizeMemoryItems(memory?.changes, 16),
  };
}

// ============ 会后纪要归一化（严格证据过滤策略）============

/**
 * 归一化 AI 生成的会后纪要
 * 策略：
 * - decisions/risks/openQuestions：严格证据（[T数字] + 决策语气）
 * - overview/topics/speakerViewpoints：宽松证据（[T数字] 存在或 4 字符连续匹配，允许基于证据的改写）
 * - 所有展示字段清理 [T数字] 标记
 */
export function normalizeFinalMinutes(finalMinutes, actions, transcripts = []) {
  const evidenceTranscripts = Array.isArray(transcripts) ? transcripts : [];
  const evidenceBacked = (value) => isEvidenceBackedByTranscript(value, evidenceTranscripts);
  // 宽松证据校验：带 [T数字] 且对应转写存在，或不含 [T数字] 但与转写有 4 字符连续匹配。
  // 用于 overview/topics.bullets/timelineChapters 等总结性字段——允许基于证据的改写，不要求逐字复述。
  const looselyGrounded = (value) => {
    const text = String(value || "");
    if (!text.trim()) return false;
    const ids = extractTranscriptIdsFromEvidence([text]);
    if (ids.length) {
      // 带 [T数字]：校验对应转写存在即可
      const byId = new Map(evidenceTranscripts.map((line) => [Number(line.id), String(line.text || "")]));
      return ids.some((id) => byId.has(id));
    }
    // 不带 [T数字]：退回 4 字符连续匹配
    return isTextGroundedByTranscripts(text, evidenceTranscripts);
  };
  const rawActionUpdates = Array.isArray(finalMinutes?.actionUpdates) && finalMinutes.actionUpdates.length
    ? finalMinutes.actionUpdates
    : actions;
  const actionUpdates = dedupeActionCandidates(rawActionUpdates)
    .slice(0, 12)
    .filter((action) => evidenceBacked(action.source || ""))
    .map((action) => {
      const owner = validateActionOwnerFromEvidence(action, evidenceTranscripts);
      const due = action.due || "待确认";
      const requestedStatus = normalizeActionStatus(action.status, "clarify");
      const status = requestedStatus === "confirmed" && !isExplicitlyConfirmedAction(action, owner, due, evidenceTranscripts)
        ? "clarify"
        : requestedStatus;
      return {
        title: String(action.title || "待办事项").slice(0, 100),
        owner,
        due,
        status,
        confidence: Number(action.confidence || 80),
        source: ensureContextPrefix(action.source || "会后归档生成"),
      };
    });
  const knownSpeakers = new Set(evidenceTranscripts.map((line) => String(line?.speaker || "").trim()).filter(Boolean));
  const verifiedSpeaker = (speaker) => knownSpeakers.has(String(speaker || "").trim()) ? String(speaker).trim() : "未知发言人";
  // overview 套话黑名单——只过滤明显空话，允许基于证据的改写
  const overviewIsFiller = (text) => /^(本次会议已归档|暂无|以下仅保留)/.test(String(text || "").trim());
  return {
    overview: looselyGrounded(finalMinutes?.overview) && !overviewIsFiller(finalMinutes?.overview)
      ? String(finalMinutes?.overview || "").replace(/\[T\d+\]/g, "").trim().slice(0, 200) || "本次会议已归档，以下仅保留可回查稳定转写支持的结论。"
      : "本次会议已归档，以下仅保留可回查稳定转写支持的结论。",
    topics: Array.isArray(finalMinutes?.topics)
      ? finalMinutes.topics.slice(0, 6).map((topic) => ({
          title: String(topic.title || "会议议题").slice(0, 40),
          bullets: Array.isArray(topic.bullets)
            ? topic.bullets.slice(0, 6)
                .filter((bullet) => looselyGrounded(String(bullet || "")))
                .map((bullet) => ensureContextPrefix(stripEvidenceTags(String(bullet))))
            : [],
        })).filter((topic) => topic.bullets.length)
      : [],
    timelineChapters: Array.isArray(finalMinutes?.timelineChapters)
      ? finalMinutes.timelineChapters.slice(0, 10).map((chapter) => ({
          startTime: String(chapter.startTime || chapter.time || "").slice(0, 16),
          title: String(chapter.title || "会议章节").slice(0, 60),
          summary: String(chapter.summary || chapter.content || "").slice(0, 500),
        })).filter((chapter) => chapter.title || chapter.summary)
      : [],
    decisions: Array.isArray(finalMinutes?.decisions)
      ? finalMinutes.decisions.slice(0, 8)
          .filter((decision) => evidenceBacked(decision) && hasExplicitDecisionEvidence(decision, evidenceTranscripts))
          .map((decision) => stripEvidenceTags(String(decision)))
      : [],
    risks: Array.isArray(finalMinutes?.risks)
      ? finalMinutes.risks.slice(0, 8).filter(evidenceBacked).map((risk) => stripEvidenceTags(String(risk)))
      : [],
    openQuestions: Array.isArray(finalMinutes?.openQuestions)
      ? finalMinutes.openQuestions.slice(0, 8).filter(evidenceBacked).map((q) => stripEvidenceTags(String(q)))
      : [],
    quoteMoments: Array.isArray(finalMinutes?.quoteMoments)
      ? finalMinutes.quoteMoments.slice(0, 5).map((moment) => ({
          quote: stripEvidenceTags(String(moment.quote || "").slice(0, 180)),
          speaker: verifiedSpeaker(moment.speaker).slice(0, 40),
          reason: String(moment.reason || "").slice(0, 220),
        })).filter((moment) => moment.quote)
      : [],
    speakerViewpoints: Array.isArray(finalMinutes?.speakerViewpoints)
      ? finalMinutes.speakerViewpoints.slice(0, 8).map((item) => ({
          speaker: verifiedSpeaker(item.speaker).slice(0, 40),
          viewpoints: Array.isArray(item.viewpoints)
            ? item.viewpoints.slice(0, 4)
                .filter((view) => looselyGrounded(String(view || "")))
                .map((view) => stripEvidenceTags(String(view).slice(0, 220)))
            : [],
        })).filter((item) => item.speaker && item.viewpoints.length)
      : [],
    projectMemory: normalizeProjectMemoryDraft({}, { ...finalMinutes, decisions: [], risks: [], openQuestions: [], topics: [] }),
    actionUpdates,
  };
}
