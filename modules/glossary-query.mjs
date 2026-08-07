/**
 * glossary-query.mjs —— 术语库查询（两端共用业务逻辑，DB 经 adapter）。
 * getGlossaryEntries/getMeetingGlossaryEntries/getAsrHotwordsForMeeting。
 * 两端各自提供 db 句柄（公网 openDb() / 公司 getPool()），SQL 一致。
 */
import { normalizeGlossaryTerm } from "./glossary.mjs";

export function getGlossaryEntries(db, { projectId, meetingId } = {}) {
  const where = ["deleted_at IS NULL"];
  const params = [];
  if (projectId !== undefined) {
    if (meetingId !== undefined) {
      // 会议转写同时使用全局、当前项目和当前会议词库；此前只按项目筛选，
      // 导致 scope=meeting 的词虽然保存成功，却从未传给实时/文件 ASR。
      where.push("(scope = 'global' OR (scope = 'project' AND project_id = ?) OR (scope = 'meeting' AND meeting_id = ?))");
      params.push(Number(projectId || 0), Number(meetingId || 0));
    } else {
      where.push("(scope = 'global' OR (scope = 'project' AND project_id = ?))");
      params.push(Number(projectId || 0));
    }
  }
  if (meetingId !== undefined) {
    where.push("(meeting_id IS NULL OR meeting_id = ?)");
    params.push(Number(meetingId || 0));
  }
  const rows = db.prepare(`
    SELECT id, scope, project_id AS projectId, meeting_id AS meetingId, term, aliases_json AS aliasesJson,
           category, weight, enabled, updated_at AS updatedAt
    FROM glossary_entries
    WHERE ${where.join(" AND ")}
    ORDER BY scope, project_id, weight DESC, id DESC
  `).all(...params);
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    meetingId: row.meetingId,
    term: row.term,
    aliases: (() => {
      try { return JSON.parse(row.aliasesJson || "[]"); } catch { return []; }
    })(),
    category: row.category || "general",
    weight: Number(row.weight || 0),
    enabled: Boolean(row.enabled),
    updatedAt: row.updatedAt,
  }));
}

export function glossaryScopePriority(scope) {
  return scope === "meeting" ? 3 : scope === "project" ? 2 : 1;
}

export function getMeetingGlossaryEntries(db, meetingId) {
  const meeting = db.prepare("SELECT project_id AS projectId FROM meetings WHERE id = ? AND deleted_at IS NULL").get(Number(meetingId || 1));
  const entries = meeting
    ? getGlossaryEntries(db, { projectId: meeting.projectId, meetingId: Number(meetingId || 0) }).filter((entry) => entry.enabled)
    : getGlossaryEntries(db).filter((entry) => entry.enabled && entry.scope === "global");
  return entries;
}

export function getAsrHotwordsForMeeting(db, meetingId, limits = {}) {
  const entries = getMeetingGlossaryEntries(db, meetingId)
    .filter((entry) => entry.enabled && entry.term)
    .sort((a, b) => glossaryScopePriority(b.scope) - glossaryScopePriority(a.scope)
      || Number(b.weight || 0) - Number(a.weight || 0)
      || Number(b.id || 0) - Number(a.id || 0));
  return selectAsrHotwords(entries, limits);
}

/**
 * 按已经排好优先级的词库条目生成 ASR 热词。
 *
 * 流式 ASR、45 秒文件 ASR 和尾段补跑必须使用同一份有界列表：否则文件
 * 校准会把所有别名无限制传给模型，既可能超过供应商的 100 个上限，也会
 * 稀释项目高权重术语。上层只负责提供端侧配置，排序和截断在 core 保持一致。
 */
export function selectAsrHotwords(entries, { maxCount = 80, maxChars = 400 } = {}) {
  const safeMaxCount = Math.max(1, Number(maxCount) || 80);
  const safeMaxChars = Math.max(1, Number(maxChars) || 400);
  const selected = [];
  const seen = new Set();
  let charCount = 0;
  const append = (value) => {
    const term = String(value || "").trim();
    const key = normalizeGlossaryTerm(term);
    const nextLength = charCount + (selected.length ? 1 : 0) + term.length;
    if (!term || seen.has(key) || selected.length >= safeMaxCount || nextLength > safeMaxChars) return;
    seen.add(key);
    selected.push(term);
    charCount = nextLength;
  };
  for (const entry of entries || []) {
    append(entry.term);
    for (const alias of entry.aliases || []) append(alias);
  }
  return selected;
}
