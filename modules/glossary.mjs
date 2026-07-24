/**
 * glossary.mjs —— 热词表工具（规范化/别名合并/去重）。
 * 被 schema.mjs（建库初始化）和 index.mjs（热词 API）共用。
 */
import { safeParseJson } from "./speaker-utils.mjs";

export function normalizeGlossaryTerm(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

export function mergeGlossaryAliases(entries, canonicalTerm) {
  const seen = new Set([normalizeGlossaryTerm(canonicalTerm)]);
  const aliases = [];
  for (const entry of entries) {
    for (const alias of safeParseJson(entry.aliasesJson) || []) {
      const text = String(alias || "").trim();
      const key = normalizeGlossaryTerm(text);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      aliases.push(text);
    }
  }
  return aliases.slice(0, 12);
}

export function dedupeGlossaryEntries(db, { preferId } = {}) {
  const rows = db.prepare(`
    SELECT id, scope, project_id AS projectId, meeting_id AS meetingId, term, aliases_json AS aliasesJson,
           category, weight, enabled, updated_at AS updatedAt
    FROM glossary_entries
    WHERE deleted_at IS NULL
    ORDER BY weight DESC, updated_at DESC, id DESC
  `).all();
  const groups = new Map();
  for (const row of rows) {
    const key = [row.scope, Number(row.projectId || 0), Number(row.meetingId || 0), normalizeGlossaryTerm(row.term)].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const now = new Date().toISOString();
  let mergedCount = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const preferred = group.find((row) => Number(row.id) === Number(preferId));
    const keeper = preferred || group[0];
    const aliases = mergeGlossaryAliases(group, keeper.term);
    const weight = Math.max(...group.map((row) => Number(row.weight || 0)));
    const enabled = group.some((row) => Boolean(row.enabled)) ? 1 : 0;
    db.prepare(`
      UPDATE glossary_entries
      SET aliases_json = ?, weight = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(aliases), weight, enabled, now, keeper.id);
    for (const duplicate of group) {
      if (duplicate.id === keeper.id) continue;
      db.prepare(`
        UPDATE glossary_entries
        SET deleted_at = ?, deleted_by_type = 'dedupe', deleted_by_id = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(now, keeper.id, duplicate.id);
      mergedCount += 1;
    }
  }
  return mergedCount;
}
