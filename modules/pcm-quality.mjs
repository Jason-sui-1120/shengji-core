/**
 * pcm-quality.mjs —— PCM 音频质量分析（两端共用）。
 * 静音比例/RMS 能量，用于覆盖补齐时判断是否跳过 ASR。
 */

export function analyzePcmQuality(pcmChunks) {
  const pcm = Buffer.concat((pcmChunks || []).filter((chunk) => Buffer.isBuffer(chunk) && chunk.length));
  if (!pcm.length) {
    return { durationMs: 0, audioBytes: 0, rms: 0, peak: 0, silenceRatio: 1 };
  }

  let sumSquares = 0;
  let peak = 0;
  let samples = 0;
  const frameSamples = 320; // 20ms @ 16kHz
  let frameEnergy = 0;
  let frameCount = 0;
  let silentFrames = 0;

  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768;
    const abs = Math.abs(sample);
    sumSquares += sample * sample;
    peak = Math.max(peak, abs);
    samples += 1;
    frameEnergy += sample * sample;
    if (samples % frameSamples === 0) {
      const frameRms = Math.sqrt(frameEnergy / frameSamples);
      if (frameRms < 0.008) silentFrames += 1;
      frameCount += 1;
      frameEnergy = 0;
    }
  }
  if (samples % frameSamples !== 0) {
    const restSamples = samples % frameSamples;
    const frameRms = Math.sqrt(frameEnergy / Math.max(1, restSamples));
    if (frameRms < 0.008) silentFrames += 1;
    frameCount += 1;
  }

  return {
    durationMs: Math.round((samples / 16000) * 1000),
    audioBytes: pcm.length,
    rms: Number(Math.sqrt(sumSquares / Math.max(1, samples)).toFixed(5)),
    peak: Number(peak.toFixed(5)),
    silenceRatio: Number((silentFrames / Math.max(1, frameCount)).toFixed(4)),
  };
}
