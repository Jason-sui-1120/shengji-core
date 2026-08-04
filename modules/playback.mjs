// playback.mjs —— 会议回放元数据共享逻辑。
//
// 统一两端 playback 返回结构（前端只消费交集）：
//   { ok, audioUrl, cues: [{ id, startSeconds, endSeconds }] }
//
// 端侧注入 deps（DB 方言 + 音频物化差异）：
//   - listTranscriptRows(meetingId) → 转写行（含 audioStartMs/audioEndMs/audioDurationMs/audioPath）
//   - listSpeakerTurns(meetingId) → 说话人段
//   - getSourceAudioInfo(meetingId) → { durationMs, status, audioBytes } | null
//   - buildAudioUrl(meetingId, hasAudio) → 端侧音频端点（公网 /playback.wav，公司 /audio）
//   - resolveChunkAudio(row) → { audioPath, durationSeconds }（仅无完整源音频时的降级拼接用）
//
// cue 时间轴用公网健壮派生逻辑：audioStartMs>0 用真实值，否则 fallbackCursor 顺序累积降级。
// 公司端之前直接 audio_start_ms/1000 无降级，脏数据（audioStartMs=0 旧记录）会导致 cue 错位。

export function turnsForRange(turns, startMs, endMs) {
  return (Array.isArray(turns) ? turns : []).filter((turn) => (
    Number(turn.endMs || 0) > Number(startMs || 0)
    && Number(turn.startMs || 0) < Number(endMs || 0)
  ));
}

export function getTranscriptAudioSortKey(row) {
  const explicit = Number(row?.audioStartMs || 0);
  if (Number(row?.audioEndMs || 0) > 0 || explicit > 0) return explicit;
  const match = String(row?.audioPath || "").match(/meeting-\d+-(\d+)-[a-f0-9]+\.wav$/i);
  return Number(match?.[1] || Number.MAX_SAFE_INTEGER);
}

export function sortTranscriptRowsByAudio(rows = []) {
  return [...rows].sort((a, b) => getTranscriptAudioSortKey(a) - getTranscriptAudioSortKey(b) || Number(a.id) - Number(b.id));
}

// 从有完整源音频的转写行派生 cue 时间轴（健壮降级版）。
// audioStartMs>0 用真实值；否则 fallbackCursor 顺序累积，避免脏数据导致 cue 错位。
export function deriveCuePositionsFromSource(orderedRows, durationSeconds) {
  const positions = new Map();
  let fallbackCursor = 0;
  for (const row of orderedRows) {
    const explicitStart = Number(row.audioStartMs || 0) / 1000;
    const explicitEnd = Number(row.audioEndMs || 0) / 1000;
    const start = explicitStart > 0 ? Math.min(durationSeconds, explicitStart) : fallbackCursor;
    const end = explicitEnd > start
      ? Math.min(durationSeconds, explicitEnd)
      : Math.min(durationSeconds, start + Math.max(0.1, Number(row.audioDurationMs || 0) / 1000));
    positions.set(row.id, { start, end: Math.max(start, end) });
    fallbackCursor = Math.max(fallbackCursor, end);
  }
  return positions;
}

// 无完整源音频时，按分块音频拼接派生 cue 时间轴（降级路径）。
export function deriveCuePositionsFromChunks(orderedRows, resolveChunkAudio) {
  // 分块：相邻行同音频文件合并
  const chunks = [];
  for (const row of orderedRows) {
    const { audioPath, durationSeconds } = resolveChunkAudio(row);
    const previous = chunks.at(-1);
    if (previous && previous.audioPath === audioPath) { previous.rows.push(row); continue; }
    chunks.push({ audioPath, duration: durationSeconds, rows: [row] });
  }
  // 按文本长度加权分配时间轴
  const positions = new Map();
  let cursor = 0;
  for (const chunk of chunks) {
    const duration = chunk.duration;
    const weights = chunk.rows.map((row) => Math.max(1, String(row.text || "").replace(/\s/g, "").length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let offset = cursor;
    chunk.rows.forEach((row, index) => {
      const end = index === chunk.rows.length - 1 ? cursor + duration : offset + duration * weights[index] / totalWeight;
      positions.set(row.id, { start: offset, end });
      offset = end;
    });
    cursor += duration;
  }
  const hasAudio = chunks.some((chunk) => chunk.audioPath);
  return { positions, totalSeconds: cursor, hasAudio };
}

// 主入口：构建 playback 元数据。
export async function buildMeetingPlayback(meetingId, deps) {
  const {
    meetingExists,
    listTranscriptRows,
    listSpeakerTurns,
    getSourceAudioInfo,
    buildAudioUrl,
    resolveChunkAudio,
  } = deps;

  if (!(await meetingExists(meetingId))) {
    return { ok: false, message: "meeting not found", cues: [], durationSeconds: 0 };
  }

  const rows = await listTranscriptRows(meetingId);
  const speakerTurns = await listSpeakerTurns(meetingId);
  const orderedRows = sortTranscriptRowsByAudio(rows);
  const sourceAudio = await getSourceAudioInfo(meetingId);

  const toCue = (row, position) => ({
    id: row.id,
    time: row.time,
    speaker: row.speaker,
    text: row.text,
    startSeconds: position.start,
    endSeconds: position.end,
    speakerTurns: turnsForRange(speakerTurns, position.start * 1000, position.end * 1000),
  });

  // 有完整源音频：用健壮派生逻辑
  if (sourceAudio) {
    const durationSeconds = sourceAudio.durationMs / 1000;
    const positions = deriveCuePositionsFromSource(orderedRows, durationSeconds);
    return {
      ok: true,
      audioUrl: buildAudioUrl(meetingId, true),
      durationSeconds: Number(durationSeconds.toFixed(3)),
      sourceAudio: {
        status: sourceAudio.status,
        bytes: sourceAudio.audioBytes,
        durationSeconds: Number(durationSeconds.toFixed(3)),
      },
      cues: orderedRows.map((row) => toCue(row, positions.get(row.id) || { start: 0, end: 0 })),
      speakerTurns,
    };
  }

  // 无完整源音频：分块拼接降级
  const { positions, totalSeconds, hasAudio } = deriveCuePositionsFromChunks(orderedRows, resolveChunkAudio);
  return {
    ok: true,
    audioUrl: buildAudioUrl(meetingId, hasAudio),
    durationSeconds: Number(totalSeconds.toFixed(3)),
    cues: orderedRows.map((row) => toCue(row, positions.get(row.id) || { start: 0, end: 0 })),
    speakerTurns,
  };
}
