/**
 * audio-utils.mjs —— 音频/WAV 处理纯函数。
 * 无状态、无 DB、无网络依赖，可被 speakers/rolling/asr-live 等模块共用。
 */

export const WAV_HEADER_BYTES = 44;

export function wrapPcm16AsWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function getWavDurationSeconds(wav) {
  if (!wav?.length || wav.length <= 44) return 0;
  const sampleRate = wav.readUInt32LE(24) || 16000;
  const bytesPerSample = wav.readUInt16LE(32) || 2;
  const dataBytes = Math.max(0, wav.length - 44);
  return dataBytes / (sampleRate * bytesPerSample);
}

export function sliceWavBySeconds(wav, startSeconds, endSeconds) {
  if (!wav?.length || wav.length <= 44) return wav;
  const sampleRate = wav.readUInt32LE(24) || 16000;
  const bytesPerSample = wav.readUInt16LE(32) || 2;
  const pcm = wav.slice(44);
  const startByte = Math.max(0, Math.floor(startSeconds * sampleRate) * bytesPerSample);
  const endByte = Math.min(pcm.length, Math.ceil(endSeconds * sampleRate) * bytesPerSample);
  if (endByte <= startByte) return wav;
  return wrapPcm16AsWav(pcm.slice(startByte, endByte), sampleRate);
}
