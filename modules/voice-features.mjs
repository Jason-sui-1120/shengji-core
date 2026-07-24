/**
 * voice-features.mjs —— 本地声学特征提取（fallback 声纹）。
 * 当 embedding 模型不可用时，用 RMS/ZCR/频谱质心/基频等特征做说话人区分。
 * 纯函数，无 DB、无网络依赖。
 */

export function extractVoiceFeatures(wav) {
  const pcm = wav.slice(44);
  const samples = [];
  for (let index = 0; index + 1 < pcm.length; index += 2) {
    samples.push(pcm.readInt16LE(index) / 32768);
  }
  if (samples.length < 1600) return null;

  const frameSize = 512;
  const hopSize = 256;
  const frames = [];
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const frame = samples.slice(start, start + frameSize);
    const rms = Math.sqrt(frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length);
    if (rms > 0.012) frames.push(frame);
  }
  if (frames.length < 3) return null;

  const stats = frames.map((frame) => getFrameVoiceStats(frame));
  const avg = (key) => stats.reduce((sum, item) => sum + item[key], 0) / stats.length;
  const values = {
    rms: avg("rms"),
    zcr: avg("zcr"),
    centroid: avg("centroid"),
    lowRatio: avg("lowRatio"),
    midRatio: avg("midRatio"),
    highRatio: avg("highRatio"),
    pitch: median(stats.map((item) => item.pitch).filter((value) => value > 0)),
  };

  return {
    rms: clampFeature(values.rms * 18),
    zcr: clampFeature(values.zcr * 7),
    centroid: clampFeature(values.centroid / 0.45),
    lowRatio: clampFeature(values.lowRatio),
    midRatio: clampFeature(values.midRatio),
    highRatio: clampFeature(values.highRatio),
    pitch: clampFeature((values.pitch || 140) / 280),
  };
}

function getFrameVoiceStats(frame) {
  let energy = 0;
  let zcr = 0;
  for (let i = 0; i < frame.length; i += 1) {
    energy += frame[i] * frame[i];
    if (i > 0 && Math.sign(frame[i]) !== Math.sign(frame[i - 1])) zcr += 1;
  }
  const spectrum = getSpectrumMagnitudes(frame, 64);
  const total = spectrum.reduce((sum, value) => sum + value, 0) || 1;
  const centroid = spectrum.reduce((sum, value, index) => sum + value * (index / spectrum.length), 0) / total;
  const low = spectrum.slice(1, 8).reduce((sum, value) => sum + value, 0) / total;
  const mid = spectrum.slice(8, 24).reduce((sum, value) => sum + value, 0) / total;
  const high = spectrum.slice(24).reduce((sum, value) => sum + value, 0) / total;
  return {
    rms: Math.sqrt(energy / frame.length),
    zcr: zcr / frame.length,
    centroid,
    lowRatio: low,
    midRatio: mid,
    highRatio: high,
    pitch: estimatePitch(frame, 16000),
  };
}

function getSpectrumMagnitudes(frame, bins) {
  const spectrum = [];
  for (let bin = 0; bin < bins; bin += 1) {
    let real = 0;
    let imag = 0;
    for (let i = 0; i < frame.length; i += 1) {
      const windowed = frame[i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (frame.length - 1)));
      const angle = (2 * Math.PI * bin * i) / frame.length;
      real += windowed * Math.cos(angle);
      imag -= windowed * Math.sin(angle);
    }
    spectrum.push(Math.sqrt(real * real + imag * imag));
  }
  return spectrum;
}

function estimatePitch(frame, sampleRate) {
  const minLag = Math.floor(sampleRate / 350);
  const maxLag = Math.floor(sampleRate / 75);
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    for (let i = 0; i + lag < frame.length; i += 1) {
      score += frame[i] * frame[i + lag];
    }
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag ? sampleRate / bestLag : 0;
}

export function getFeatureDistance(a, b) {
  const weights = {
    rms: 0.3,
    zcr: 0.8,
    centroid: 1.3,
    lowRatio: 1.2,
    midRatio: 1.2,
    highRatio: 1.2,
    pitch: 1.8,
  };
  let total = 0;
  let weightTotal = 0;
  for (const [key, weight] of Object.entries(weights)) {
    total += Math.abs((a[key] || 0) - (b[key] || 0)) * weight;
    weightTotal += weight;
  }
  return total / weightTotal;
}

export function mergeVoiceFeatures(existing, next, count) {
  const merged = {};
  const nextWeight = 1 / Math.max(2, Number(count || 1) + 1);
  for (const key of Object.keys(next)) {
    merged[key] = (existing[key] || 0) * (1 - nextWeight) + next[key] * nextWeight;
  }
  return merged;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clampFeature(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
