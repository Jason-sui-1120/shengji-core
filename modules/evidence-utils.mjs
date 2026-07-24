// evidence-utils.mjs —— 行动项证据校验纯函数（两端共用）。
// 从公网端 index.mjs 抽出，供 normalizeFinalMinutes 等场景做证据背书校验。

export function uniqueNumbers(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite)));
}

export function extractTranscriptIdsFromEvidence(items) {
  const ids = [];
  for (const item of Array.isArray(items) ? items : []) {
    for (const match of String(item || "").matchAll(/\[T(\d+)\]/g)) ids.push(Number(match[1]));
  }
  return uniqueNumbers(ids);
}

export function getEvidenceTranscriptText(value, transcripts = []) {
  const ids = new Set(extractTranscriptIdsFromEvidence([value]));
  return (Array.isArray(transcripts) ? transcripts : [])
    .filter((line) => ids.has(Number(line?.id)))
    .map((line) => String(line?.text || ""))
    .join(" ");
}

export function normalizeForTranscriptCompare(value) {
  return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

export function isTextGroundedByTranscripts(value, transcripts = []) {
  const claim = normalizeForTranscriptCompare(String(value || "").replace(/\[T\d+\]/g, ""));
  if (claim.length < 4) return false;
  const source = normalizeForTranscriptCompare((transcripts || []).map((line) => line?.text || "").join(""));
  if (!source) return false;
  for (let index = 0; index <= claim.length - 4; index += 1) {
    if (source.includes(claim.slice(index, index + 4))) return true;
  }
  return false;
}

export function isEvidenceBackedByTranscript(value, transcripts = []) {
  const ids = extractTranscriptIdsFromEvidence([value]);
  if (!ids.length) return false;
  const byId = new Map((transcripts || []).map((line) => [Number(line.id), String(line.text || "")]));
  const sources = ids.map((id) => byId.get(id)).filter(Boolean);
  return sources.length > 0 && isTextGroundedByTranscripts(value, sources.map((text) => ({ text })));
}

export function hasExplicitDecisionEvidence(value, transcripts = []) {
  const source = getEvidenceTranscriptText(value, transcripts);
  if (!source) return false;
  const hasConfirmation = /(确定|确认|决定|拍板|就这么定|按.{0,16}(执行|推进|落实)|明确.{0,12}(方案|方向|边界|采用))/.test(source);
  const discussionOnly = /(建议|可以|考虑|要不要|是否|如果|讨论)/.test(source)
    && !/(确定|确认|决定|拍板|就这么定|明确)/.test(source);
  return hasConfirmation && !discussionOnly;
}

export function isExplicitlyConfirmedAction(action, owner, due, transcripts = []) {
  if (owner === "待确认" && (!due || due === "待确认")) return false;
  const source = getEvidenceTranscriptText(action?.source, transcripts);
  if (!source) return false;
  if (/(建议|可以|考虑|要不要|是否|如果|讨论)/.test(source) && !/(确定|确认|决定|拍板|明确)/.test(source)) return false;
  return /(确定|确认|决定|拍板|明确|由.{0,16}(负责|跟进|执行)|交给.{0,16}|承诺.{0,16}(完成|推进|交付)|要求.{0,16}(完成|推进|提交|落实))/.test(source);
}
