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

export function getAsrHotwordsForMeeting(db, meetingId) {
  const entries = getMeetingGlossaryEntries(db, meetingId)
    .filter((entry) => entry.enabled && entry.term)
    .sort((a, b) => glossaryScopePriority(b.scope) - glossaryScopePriority(a.scope)
      || Number(b.weight || 0) - Number(a.weight || 0)
      || Number(b.id || 0) - Number(a.id || 0));
  const selected = [];
  const seen = new Set();
  let charCount = 0;
  const append = (value) => {
    const term = String(value || "").trim();
    const key = normalizeGlossaryTerm(term);
    const nextLength = charCount + (selected.length ? 1 : 0) + term.length;
    if (!term || seen.has(key) || nextLength > 700) return;
    seen.add(key);
    selected.push(term);
    charCount = nextLength;
  };
  for (const entry of entries) {
    append(entry.term);
    for (const alias of entry.aliases || []) append(alias);
  }
  return selected;
}
