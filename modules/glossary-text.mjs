/**
 * glossary-text.mjs —— 术语文本处理纯函数（两端共用）。
 * 别名变体展开、字面替换、glossary 校正。
 */
import { normalizeTranscriptSegment } from "./text-utils.mjs";

export function applyGlossaryAliasCorrections(text, glossaryEntries = []) {
  let result = String(text || "");
  if (!result) return result;
  const pairs = [];
  for (const entry of glossaryEntries || []) {
    if (!entry?.enabled || !entry.term) continue;
    const term = String(entry.term || "").trim();
    if (!term) continue;
    // 词库是唯一的替换白名单。对缩写/字母数字词，自动补齐大小写、
    // 全角和中文数字读法，避免为每个业务词单独写死规则。
    for (const alias of expandGlossaryVariants(term, entry.aliases || [])) {
      const from = String(alias || "").trim();
      if (!from || from === term || from.length < 2) continue;
      pairs.push({ from, to: term, weight: Number(entry.weight || 80) });
    }
  }
  pairs.sort((a, b) => b.weight - a.weight || b.from.length - a.from.length);
  for (const pair of pairs) {
    result = replaceLiteralTerm(result, pair.from, pair.to);
  }
  return normalizeTranscriptSegment(result);
}

export function expandGlossaryVariants(term, aliases = []) {
  const values = new Set([term, ...aliases].map((value) => String(value || "").trim()).filter(Boolean));
  const chineseDigits = { 0: "零", 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九" };
  for (const value of [...values]) {
    const compact = value.replace(/[\s＿_-]/g, "");
    // ASR 常把缩写逐字播报（如“m c p”），也会把中文业务词拆成
    // “贝 拉”这类带空格的片段；只对词库中的标准词/别名生成变体，
    // 不影响普通文本。
    if (/^[A-Za-z]{2,}$/.test(compact)) values.add(compact.split("").join(" "));
    if (/^[\u4e00-\u9fa5]{2,}$/.test(compact)) values.add(compact.split("").join(" "));
    if (/^[A-Za-z]+\d+[A-Za-z\d]*$/.test(compact)) {
      values.add(compact);
      values.add(compact.toLowerCase());
      values.add(compact.replace(/\d/g, (digit) => chineseDigits[digit]));
      values.add(compact.replace(/\d/g, (digit) => ` ${chineseDigits[digit]} `).replace(/\s+/g, " ").trim());
    }
  }
  return [...values];
}

export function replaceLiteralTerm(text, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^[A-Za-z0-9_-]+$/.test(from)) {
    return text.replace(new RegExp(`\\b${escaped}\\b`, "gi"), to);
  }
  return text.split(from).join(to);
}

