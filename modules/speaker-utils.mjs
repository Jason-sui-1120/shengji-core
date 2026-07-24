/**
 * speaker-utils.mjs —— 说话人向量/embedding 处理纯函数。
 * 无状态、无 DB、无网络依赖，可被 speakers.mjs 和 voice-cluster 共用。
 */

export function normalizeVector(vector) {
  const values = (Array.isArray(vector) ? vector : []).map(Number).filter(Number.isFinite);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

export function cosineSimilarity(a, b) {
  const av = normalizeVector(a);
  const bv = normalizeVector(b);
  const length = Math.min(av.length, bv.length);
  if (!length) return 0;
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += av[index] * bv[index];
  return sum;
}

export function mergeEmbeddingVector(existing, next, count) {
  const oldVector = normalizeVector(existing);
  const nextVector = normalizeVector(next);
  const length = Math.min(oldVector.length, nextVector.length);
  const nextWeight = 1 / Math.max(2, Number(count || 1) + 1);
  const merged = [];
  for (let index = 0; index < length; index += 1) {
    merged.push(oldVector[index] * (1 - nextWeight) + nextVector[index] * nextWeight);
  }
  return normalizeVector(merged);
}

export function matchEmbeddingProfile(profiles, embedding) {
  let matched = null;
  for (const profile of profiles) {
    const similarity = cosineSimilarity(embedding, profile.profile.vector);
    if (!matched || similarity > matched.similarity) matched = { ...profile, similarity };
  }
  return matched;
}

export function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
