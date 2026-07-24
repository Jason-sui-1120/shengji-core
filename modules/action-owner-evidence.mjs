function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractEvidenceIds(value) {
  return [...String(value || "").matchAll(/\[T(\d+)\]/g)].map((match) => Number(match[1]));
}

export function validateActionOwnerFromEvidence(action, transcripts = []) {
  const owner = String(action?.owner || "待确认").trim() || "待确认";
  if (owner === "待确认") return owner;
  const ids = new Set(extractEvidenceIds(action?.source));
  const cited = (Array.isArray(transcripts) ? transcripts : []).filter((line) => ids.has(Number(line?.id)));
  if (!cited.length) return "待确认";

  const escapedOwner = escapeRegExp(owner).replace(/\s+/g, "\\s*");
  const explicitAssignment = new RegExp(
    `(?:由|让|请|交给)\\s*${escapedOwner}\\s*(?:来|去|先)?(?:负责|跟进|推进|执行|完成|整理|确认|验证|测试|开发|处理|反馈|对齐|上线)|${escapedOwner}\\s*(?:负责|来跟进|来推进|来执行|来完成|去处理|去确认|去验证|去测试|承诺)`,
    "i",
  );
  if (cited.some((line) => explicitAssignment.test(String(line?.text || "")))) return owner;

  // “说话人N”只有在同一证据行中出现明确第一人称承诺时才能作为负责人；
  // 单纯由该说话人汇报计划，不等于任务归属已确认。
  if (/^说话人\s*\d+$/i.test(owner)) {
    const firstPersonCommitment = /(?:我|我们)(?:来|会|负责|跟进|推进|执行|完成|整理|确认|验证|测试|开发|处理|反馈|对齐|上线)/;
    if (cited.some((line) => String(line?.speaker || "").replace(/\s+/g, "") === owner.replace(/\s+/g, "")
      && firstPersonCommitment.test(String(line?.text || "")))) return owner;
  }
  return "待确认";
}
