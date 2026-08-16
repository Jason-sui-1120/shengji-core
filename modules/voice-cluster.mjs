/**
 * voice-cluster.mjs —— 会后声纹聚类的纯算法层（公网端）。
 *
 * 移植自公司端 speaker-reconciliation.mjs，merge_more 参数固化为默认。
 * 设计原则：不信任文件 ASR 返回的 speaker_id（只当"可能的切换点"），
 * 用词级时间戳切出短连续语音块，再由声纹向量在会议内聚类。
 * 本模块不读写数据库、不发起网络请求，方便独立测试与 benchmark 验证。
 */

export function normalizeVector(vector) {
  const values = (Array.isArray(vector) ? vector : []).map(Number).filter(Number.isFinite);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

export function cosineSimilarity(left, right) {
  const a = normalizeVector(left);
  const b = normalizeVector(right);
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) total += a[index] * b[index];
  return length ? total : 0;
}

function averageVector(vectors) {
  const usable = vectors.filter((vector) => Array.isArray(vector) && vector.length);
  if (!usable.length) return [];
  const length = Math.min(...usable.map((vector) => vector.length));
  return normalizeVector(Array.from({ length }, (_, index) => (
    usable.reduce((sum, vector) => sum + Number(vector[index] || 0), 0) / usable.length
  )));
}

/**
 * 将词级时间戳组合成 1.2~5.5 秒的音频块。大停顿、过长窗口和非连续时间均会切开；
 * 因此不会借用文件 ASR 给出的 speaker_id，也不会把两个相隔很久的发言拼成一块。
 */
export function buildVoiceWindows(words, options = {}) {
  const minSeconds = Number(options.minSeconds ?? 1.2);
  const targetSeconds = Number(options.targetSeconds ?? 3.2);
  const maxSeconds = Number(options.maxSeconds ?? 5.5);
  const maxGapSeconds = Number(options.maxGapSeconds ?? 0.65);
  const fromSeconds = Math.max(0, Number(options.fromSeconds ?? 0));
  const toSeconds = Number.isFinite(Number(options.toSeconds)) ? Number(options.toSeconds) : Number.POSITIVE_INFINITY;
  const windows = [];
  let current = null;

  const commit = () => {
    if (!current) return;
    if (current.endSeconds - current.startSeconds >= minSeconds) windows.push(current);
    current = null;
  };

  for (const word of [...(words || [])].sort((a, b) => a.startSeconds - b.startSeconds)) {
    const startSeconds = Math.max(fromSeconds, Number(word.startSeconds || 0));
    const endSeconds = Math.min(toSeconds, Number(word.endSeconds || 0));
    const legacySpeaker = String(word.legacySpeaker || word.speaker || "").trim();
    if (!(endSeconds > startSeconds)) continue;
    if (!current) {
      current = { startSeconds, endSeconds, text: String(word.text || ""), legacySpeaker };
      continue;
    }
    const gap = startSeconds - current.endSeconds;
    const nextDuration = endSeconds - current.startSeconds;
    // 已有会中轨道虽然不是最终真值，但它仍是可靠的“可能换人”边界。
    // 不允许把两个不同临时标签拼进同一个声纹窗口，否则 embedding 本身就会混人。
    const speakerChanged = Boolean(current.legacySpeaker && legacySpeaker && current.legacySpeaker !== legacySpeaker);
    // 达到目标长度后，在自然停顿处优先提交；超过上限则绝不继续扩大。
    if (speakerChanged || gap > maxGapSeconds || nextDuration > maxSeconds || (current.endSeconds - current.startSeconds >= targetSeconds && gap >= 0.18)) {
      commit();
      current = { startSeconds, endSeconds, text: String(word.text || ""), legacySpeaker };
      continue;
    }
    current.endSeconds = Math.max(current.endSeconds, endSeconds);
    current.text += String(word.text || "");
  }
  commit();
  return windows;
}

/**
 * 在固定调用预算内优先覆盖已有临时说话人标签，再用全场均匀样本补齐。
 * 旧标签只作为抽样分层和切窗边界，不直接当最终身份；真正身份仍由声纹聚类决定。
 */
export function selectVoiceWindowSamples(windows, maxSamples = 16, options = {}) {
  const ordered = [...(windows || [])].sort((a, b) => Number(a.startSeconds || 0) - Number(b.startSeconds || 0));
  const limit = Math.max(1, Math.floor(Number(maxSamples || 16)));
  if (ordered.length <= limit) return ordered;

  const minPerLabel = Math.max(1, Math.floor(Number(options.minPerLabel ?? 2)));
  const pendingLabels = new Set(["", "待识别", "实时"]);
  const groups = new Map();
  for (let index = 0; index < ordered.length; index += 1) {
    const label = String(ordered[index]?.legacySpeaker || "").trim();
    if (pendingLabels.has(label)) continue;
    const group = groups.get(label) || { label, indexes: [], seconds: 0, firstIndex: index };
    group.indexes.push(index);
    group.seconds += Math.max(0, Number(ordered[index].endSeconds || 0) - Number(ordered[index].startSeconds || 0));
    groups.set(label, group);
  }

  const uniformIndexes = (indexes, count) => {
    if (indexes.length <= count) return indexes;
    const selected = [];
    for (let i = 0; i < count; i += 1) {
      selected.push(indexes[Math.min(indexes.length - 1, Math.floor((i + 0.5) * indexes.length / count))]);
    }
    return selected;
  };

  const selected = new Set();
  const maxCoveredGroups = Math.max(1, Math.floor(limit / minPerLabel));
  const prioritizedGroups = [...groups.values()]
    .sort((left, right) => right.seconds - left.seconds || left.firstIndex - right.firstIndex)
    .slice(0, maxCoveredGroups);
  for (const group of prioritizedGroups) {
    for (const index of uniformIndexes(group.indexes, Math.min(minPerLabel, group.indexes.length))) selected.add(index);
  }

  // 剩余预算保持全场时间覆盖，避免只照顾旧标签而漏掉待识别片段或新说话人。
  for (const index of uniformIndexes(ordered.map((_, i) => i), limit)) {
    if (selected.size >= limit) break;
    selected.add(index);
  }
  for (let index = 0; selected.size < limit && index < ordered.length; index += 1) selected.add(index);
  return [...selected].sort((a, b) => a - b).map((index) => ordered[index]);
}

/**
 * merge_more 聚类参数（benchmark 两段验证过门禁：调参段 76.6% / holdout 段 76.3%）。
 * CAM++ 声纹同一人相似度集中在 0.65-0.75 区间，mergeThreshold 需降到 0.71
 * 才能把同一人的碎片 cluster 合并完整；过高的 mergeThreshold 会导致一人被拆成多个。
 */
export const MERGE_MORE_PARAMS = Object.freeze({
  assignThreshold: 0.64,
  mergeThreshold: 0.71,
  minMargin: 0.07,
});

/**
 * 保守的会议内凝聚聚类。低置信边界保留为 unknown，而不是强行赋给错误说话人。
 * 返回的 cluster id 只在本次会议内有效，后续由 profile 映射成展示名。
 */
export function clusterVoiceEmbeddings(samples, options = {}) {
  const assignThreshold = Number(options.assignThreshold ?? MERGE_MORE_PARAMS.assignThreshold);
  const mergeThreshold = Number(options.mergeThreshold ?? MERGE_MORE_PARAMS.mergeThreshold);
  const minMargin = Number(options.minMargin ?? MERGE_MORE_PARAMS.minMargin);
  const clusters = [];
  const assignments = [];
  const ordered = [...(samples || [])]
    .filter((sample) => Array.isArray(sample.vector) && sample.vector.length)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  for (const sample of ordered) {
    const ranked = clusters.map((cluster) => ({ cluster, similarity: cosineSimilarity(sample.vector, cluster.centroid) }))
      .sort((a, b) => b.similarity - a.similarity);
    const best = ranked[0];
    const margin = (best?.similarity || 0) - (ranked[1]?.similarity || 0);
    let cluster = best?.cluster;
    // “没有相似画像”才意味着可能是新说话人；
    // “两个画像都很像”是不可区分，而不是第 N 个新说话人。
    const hasKnownCandidate = Boolean(best && best.similarity >= assignThreshold);
    const ambiguous = hasKnownCandidate && ranked.length >= 2 && margin < minMargin;
    let accepted = false;
    if (!hasKnownCandidate) {
      cluster = { id: `cluster_${clusters.length + 1}`, vectors: [normalizeVector(sample.vector)], members: [] };
      clusters.push(cluster);
      accepted = true;
    } else if (!ambiguous) {
      cluster.vectors.push(normalizeVector(sample.vector));
      accepted = true;
    }
    if (accepted) {
      cluster.centroid = averageVector(cluster.vectors);
      cluster.members.push(sample);
    }
    assignments.push({ ...sample, clusterId: accepted ? cluster.id : "unknown", similarity: Number((best?.similarity || 1).toFixed(4)), margin: Number((margin || 1).toFixed(4)), accepted });
  }

  // 仅合并两个高相似、均已有多个样本支持的簇，避免一句短插话把两个真人簇拖在一起。
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        const a = clusters[left]; const b = clusters[right];
        if (a.members.length < 2 || b.members.length < 2 || cosineSimilarity(a.centroid, b.centroid) < mergeThreshold) continue;
        a.vectors.push(...b.vectors); a.members.push(...b.members); a.centroid = averageVector(a.vectors);
        for (const assignment of assignments) if (assignment.clusterId === b.id) assignment.clusterId = a.id;
        clusters.splice(right, 1); merged = true; break outer;
      }
    }
  }

  return {
    clusters: clusters.map((cluster) => ({ id: cluster.id, sampleCount: cluster.members.length, centroid: cluster.centroid })),
    assignments,
  };
}

/** 把微片段身份回填到稳定稿；重叠加权，且低置信/低覆盖行明确保持待识别。 */
export function assignTranscriptSpeakers(transcripts, assignments, options = {}) {
  const minCoverage = Number(options.minCoverage ?? 0.45);
  const minDominance = Number(options.minDominance ?? 0.62);
  return (transcripts || []).map((row) => {
    const start = Number(row.audioStartMs || 0) / 1000;
    const end = Number(row.audioEndMs || 0) / 1000;
    const duration = Math.max(0.001, end - start);
    const weights = new Map();
    let covered = 0;
    for (const sample of assignments || []) {
      const overlap = Math.max(0, Math.min(end, sample.endSeconds) - Math.max(start, sample.startSeconds));
      if (!overlap) continue;
      covered += overlap;
      weights.set(sample.clusterId, (weights.get(sample.clusterId) || 0) + overlap);
    }
    const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    const coverage = Math.min(1, covered / duration);
    const dominance = best ? best[1] / Math.max(covered, 0.001) : 0;
    const confident = Boolean(best && coverage >= minCoverage && dominance >= minDominance);
    return {
      ...row,
      proposedSpeaker: confident ? best[0] : "待识别",
      proposedConfidence: Math.round(100 * Math.min(1, coverage * dominance)),
      diagnostics: { coverage: Number(coverage.toFixed(3)), dominance: Number(dominance.toFixed(3)), candidateCount: ranked.length },
    };
  });
}

/**
 * 先按绝对时间直接回填，再用已确认样本把会中产生的“临时说话人标签”收敛到
 * 会后确认的会议级标签。这样不需要为了覆盖整场会议再调用数十次声纹服务，
 * 也不会只更新抽样命中的少量行、让旧的说话人 3/4 长期残留在页面上。
 *
 * 传播只适用于非人工、非“待识别”标签；同一旧标签至少需要两行证据（只有
 * 一行的标签则要求该行本身被直接命中），且证据必须明显指向同一个最终说话人。
 * 时间直接命中的结果始终优先于标签传播。
 */
export function assignTranscriptSpeakersWithLabelPropagation(transcripts, assignments, options = {}) {
  const rows = Array.isArray(transcripts) ? transcripts : [];
  const direct = assignTranscriptSpeakers(rows, assignments, options);
  const minLabelDominance = Number(options.minLabelDominance ?? 0.78);
  const minEvidenceRows = Math.max(1, Number(options.minEvidenceRows ?? 2));
  const pendingLabels = new Set(["", "待识别", "实时"]);
  const totalsByLegacyLabel = new Map();
  const evidenceByLegacyLabel = new Map();

  for (const row of rows) {
    const legacyLabel = String(row?.speaker || "").trim();
    if (row?.userEdited || row?.speakerSource === "manual" || pendingLabels.has(legacyLabel)) continue;
    totalsByLegacyLabel.set(legacyLabel, (totalsByLegacyLabel.get(legacyLabel) || 0) + 1);
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const proposal = direct[index];
    const legacyLabel = String(row?.speaker || "").trim();
    const canonicalLabel = String(proposal?.proposedSpeaker || "").trim();
    if (
      row?.userEdited
      || row?.speakerSource === "manual"
      || pendingLabels.has(legacyLabel)
      || pendingLabels.has(canonicalLabel)
    ) continue;
    const durationSeconds = Math.max(0.001, (Number(row?.audioEndMs || 0) - Number(row?.audioStartMs || 0)) / 1000);
    const coverage = Math.max(0, Number(proposal?.diagnostics?.coverage || 0));
    const dominance = Math.max(0, Number(proposal?.diagnostics?.dominance || 0));
    const weight = durationSeconds * Math.max(0.05, coverage * dominance);
    const legacyEvidence = evidenceByLegacyLabel.get(legacyLabel) || { rowIndexes: new Set(), byCanonical: new Map() };
    const canonicalEvidence = legacyEvidence.byCanonical.get(canonicalLabel) || { weight: 0, confidenceTotal: 0, count: 0 };
    canonicalEvidence.weight += weight;
    canonicalEvidence.confidenceTotal += Number(proposal?.proposedConfidence || 0);
    canonicalEvidence.count += 1;
    legacyEvidence.rowIndexes.add(index);
    legacyEvidence.byCanonical.set(canonicalLabel, canonicalEvidence);
    evidenceByLegacyLabel.set(legacyLabel, legacyEvidence);
  }

  const canonicalByLegacyLabel = new Map();
  for (const [legacyLabel, evidence] of evidenceByLegacyLabel) {
    const ranked = [...evidence.byCanonical.entries()].sort((left, right) => right[1].weight - left[1].weight);
    const winner = ranked[0];
    if (!winner) continue;
    const totalWeight = ranked.reduce((sum, item) => sum + item[1].weight, 0);
    const labelDominance = winner[1].weight / Math.max(0.001, totalWeight);
    const totalRows = Number(totalsByLegacyLabel.get(legacyLabel) || 0);
    const requiredEvidenceRows = totalRows <= 1 ? 1 : Math.min(minEvidenceRows, totalRows);
    if (evidence.rowIndexes.size < requiredEvidenceRows || labelDominance < minLabelDominance) continue;
    canonicalByLegacyLabel.set(legacyLabel, {
      speaker: winner[0],
      confidence: Math.round(winner[1].confidenceTotal / Math.max(1, winner[1].count)),
      evidenceRows: evidence.rowIndexes.size,
      dominance: Number(labelDominance.toFixed(3)),
    });
  }

  return direct.map((proposal, index) => {
    if (proposal?.proposedSpeaker && !pendingLabels.has(String(proposal.proposedSpeaker).trim())) return proposal;
    const row = rows[index];
    if (row?.userEdited || row?.speakerSource === "manual") return proposal;
    const legacyLabel = String(row?.speaker || "").trim();
    const canonical = canonicalByLegacyLabel.get(legacyLabel);
    if (!canonical) return proposal;
    return {
      ...proposal,
      proposedSpeaker: canonical.speaker,
      proposedConfidence: Math.max(55, Math.min(90, canonical.confidence)),
      diagnostics: {
        ...(proposal?.diagnostics || {}),
        propagatedFromLabel: legacyLabel,
        labelEvidenceRows: canonical.evidenceRows,
        labelDominance: canonical.dominance,
      },
    };
  });
}
