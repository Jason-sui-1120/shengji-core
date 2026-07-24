/**
 * live-asr-helpers.mjs —— 实时 ASR 辅助函数（两端共用）。
 * 源音频管理/转写处理/滚动恢复/会后封存。
 * DB 相关函数接收 db 参数（openDb() 结果），由调用方注入。
 */

export function bumpMeetingStableRevision(db, meetingId) {
  db.prepare("UPDATE meetings SET stable_revision = stable_revision + 1 WHERE id = ?").run(Number(meetingId || 0));
  return Number(db.prepare("SELECT stable_revision AS stableRevision FROM meetings WHERE id = ?").get(Number(meetingId || 0))?.stableRevision || 0);
}

export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

export function savePcmAsWav(pcmChunks, meetingId) {
  const pcm = Buffer.concat(pcmChunks.filter((chunk) => Buffer.isBuffer(chunk) && chunk.length));
  if (!pcm.length) return { audioPath: "", wav: null };
  const wav = wrapPcm16AsWav(pcm, 16000);
  const fileName = `meeting-${Number(meetingId || 1)}-${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
  const audioPath = path.join(audioDir, fileName);
  fs.writeFileSync(audioPath, wav);
  return { audioPath, wav };
}

export function appendMeetingSourceAudio(meetingId, pcm) {
  if (!Buffer.isBuffer(pcm) || !pcm.length) return Promise.resolve();
  const key = Number(meetingId || 0);
  const state = meetingSourceAudioWrites.get(key) || ensureMeetingSourceAudio(key);
  const chunk = Buffer.from(pcm);
  state.scheduledBytes = Math.max(0, Number(state.scheduledBytes ?? state.bytes ?? 0) + chunk.length);
  // 每个连接共用同一条 promise 链，断线重连也不会并发写乱源文件。
  // 在写入完成后再更新 state.bytes，避免 DB 中的字节数大于实际文件大小。
  state.chain = state.chain
    .catch(() => undefined)
    .then(() => fs.promises.appendFile(state.audioPath, chunk))
    .then(() => { state.bytes = Math.max(Number(state.bytes || 0) + chunk.length, 0); })
    .catch((error) => {
      state.failed = true;
      throw error;
    });
  return state.chain;
}

export async function buildTranscriptLineDrafts({
  meetingId,
  startedAt,
  text,
  fallbackSpeaker,
  audioPath,
  wav,
  diarizationSegments,
  audioStartMs = 0,
  audioEndMs = 0,
}) {
  const normalizedText = normalizeTranscriptSegment(text);
  const fallbackDraft = () => [{
    meetingId,
    time: startedAt,
    speaker: fallbackSpeaker?.speaker || "待识别",
    text: normalizedText,
    speakerSource: fallbackSpeaker?.source || "pending",
    speakerConfidence: fallbackSpeaker?.confidence || 0,
    audioPath,
    audioStartMs,
    audioEndMs,
  }];

  const segments = getUsableDiarizationSegments(diarizationSegments, normalizedText, wav);
  if (segments.length < 2) return fallbackDraft();

  const textParts = splitTranscriptTextByDiarization(normalizedText, segments);
  if (textParts.length !== segments.length) return fallbackDraft();

  const drafts = [];
  for (let index = 0; index < segments.length; index += 1) {
    const partText = normalizeTranscriptSegment(textParts[index]);
    if (!partText) continue;
    const segment = segments[index];
    const segmentWav = sliceWavBySeconds(wav, segment.start, segment.end);
    const segmentSpeaker = await identifySpeakerFromAudio({ meetingId, wav: segmentWav, audioPath: "" });
    drafts.push({
      meetingId,
      time: offsetTimeLabel(startedAt, segment.start),
      speaker: segmentSpeaker?.speaker || segment.speaker || fallbackSpeaker?.speaker || "待识别",
      text: partText,
      speakerSource: segmentSpeaker?.source || "diarization",
      speakerConfidence: segmentSpeaker?.confidence || segment.confidence || 70,
      audioPath,
      audioStartMs: Math.round(Number(audioStartMs || 0) + Number(segment.start || 0) * 1000),
      audioEndMs: Math.round(Number(audioStartMs || 0) + Number(segment.end || 0) * 1000),
    });
  }

  return drafts.length >= 2 ? drafts : fallbackDraft();
}

export function shouldFlushTranscriptBuffer(buffer) {
  const compact = buffer.replace(/\s/g, "");
  if (!compact) return false;
  if (compact.length >= 180) return true;
  return false;
}

export function shouldWaitForMoreSpeech(text) {
  const compact = String(text || "").replace(/\s/g, "");
  if (!compact) return false;
  if (compact.length < ASR_MIN_STABLE_CHARS) return true;
  if (compact.length < ASR_MIN_STABLE_CHARS + 8 && looksSemanticallyIncomplete(text)) return true;
  return false;
}

export function looksSemanticallyIncomplete(text) {
  const value = normalizeTranscriptSegment(text);
  const compact = value.replace(/\s/g, "");
  if (!compact) return false;
  if (/[。！？!?]$/.test(compact)) return false;
  if (/[，,、：:；;]$/.test(compact)) return true;
  if (/(然后|但是|因为|所以|如果|就是|比如|包括|以及|或者|而且|另外|接下来|主要是|核心是|问题是|是不是|能不能|要不要|我们要|我们需要|我觉得|那就|这个|那个|就是这个|其实|可能|应该|需要|先|再|把|跟|给|让|在|对|和|及|与)$/.test(compact)) return true;
  if (/^(嗯|啊|呃|哦|对|是|好|行|可以|然后|但是|所以)$/.test(compact)) return true;
  if (compact.length <= 8 && !/[。！？!?]$/.test(compact)) return true;
  return false;
}

export function getFinalizedMeetingByMeetingId(meetingId, openDb) {
  const db = openDb();
  const saved = db.prepare(`
    SELECT
      id,
      meeting_id AS meetingId,
      title,
      project_name AS projectName,
      model,
      overview,
      topics_json AS topicsJson,
      decisions_json AS decisionsJson,
      risks_json AS risksJson,
      open_questions_json AS openQuestionsJson,
      action_snapshot_json AS actionSnapshotJson,
      timeline_chapters_json AS timelineChaptersJson,
      quote_moments_json AS quoteMomentsJson,
      speaker_viewpoints_json AS speakerViewpointsJson,
      transcript_count AS transcriptCount,
      source_revision AS sourceRevision,
      created_at AS createdAt
    FROM finalized_meetings
    WHERE meeting_id = ? AND deleted_at IS NULL
  `).get(Number(meetingId || 0));
  db.close();
  if (!saved) return null;
  return {
    id: saved.id,
    meetingId: saved.meetingId,
    title: saved.title,
    projectName: saved.projectName,
    model: saved.model,
    overview: saved.overview,
    topics: JSON.parse(saved.topicsJson),
    decisions: JSON.parse(saved.decisionsJson),
    risks: JSON.parse(saved.risksJson),
    openQuestions: JSON.parse(saved.openQuestionsJson),
    actionSnapshot: JSON.parse(saved.actionSnapshotJson),
    timelineChapters: safeParseJson(saved.timelineChaptersJson) ?? [],
    quoteMoments: safeParseJson(saved.quoteMomentsJson) ?? [],
    speakerViewpoints: safeParseJson(saved.speakerViewpointsJson) ?? [],
    transcriptCount: saved.transcriptCount,
    sourceRevision: Number(saved.sourceRevision || 0),
    createdAt: saved.createdAt,
  };
}

export function getMeetingLiveRecord(meetingId, openDb) {
  const db = openDb();
  const row = db.prepare("SELECT id, status, deleted_at AS deletedAt FROM meetings WHERE id = ?").get(Number(meetingId || 0));
  db.close();
  return row || null;
}

export function insertTranscript(body, openDb) {
  const db = openDb();
  const stabilityStatus = body.stabilityStatus || (body.speakerSource === "manual" || !body.asrModel || !ROLLING_ASR_ENABLED ? "stable" : "draft");
  let stableRevision = Number(body.stableRevision || 0);
  if (stabilityStatus === "stable" && !stableRevision) {
    stableRevision = bumpMeetingStableRevision(db, Number(body.meetingId || 1));
  }
  db.prepare("UPDATE transcripts SET focus = 0 WHERE meeting_id = ?").run(Number(body.meetingId || 1));
  const stmt = db.prepare(`
    INSERT INTO transcripts (
      meeting_id, at_time, speaker, text, focus, created_at, speaker_source, audio_path, speaker_confidence,
      raw_text, correction_applied, correction_reason, asr_model, flush_reason,
      audio_duration_ms, audio_start_ms, audio_end_ms, audio_bytes, audio_rms, audio_peak, silence_ratio, hotwords_json,
      stability_status, stable_revision
    )
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const quality = body.quality || {};
  const result = stmt.run(
    Number(body.meetingId || 1),
    body.time,
    body.speaker,
    body.text,
    new Date().toISOString(),
    body.speakerSource || "manual",
    body.audioPath || "",
    Number(body.speakerConfidence || 0),
    body.rawText || "",
    body.correctionApplied ? 1 : 0,
    body.correctionReason || "",
    body.asrModel || "",
    body.flushReason || "",
    Number(quality.durationMs || 0),
    Number(body.audioStartMs || 0),
    Number(body.audioEndMs || 0),
    Number(quality.audioBytes || 0),
    Number(quality.rms || 0),
    Number(quality.peak || 0),
    Number(quality.silenceRatio || 0),
    JSON.stringify(body.hotwords || []),
    stabilityStatus,
    stableRevision,
  );
  const row = db.prepare(`
    SELECT id, at_time AS time, speaker, text, focus, speaker_source AS speakerSource, speaker_confidence AS speakerConfidence,
      raw_text AS rawText, correction_applied AS correctionApplied, correction_reason AS correctionReason,
      asr_model AS asrModel, flush_reason AS flushReason, audio_duration_ms AS audioDurationMs, audio_start_ms AS audioStartMs, audio_end_ms AS audioEndMs,
      audio_bytes AS audioBytes, audio_rms AS audioRms, audio_peak AS audioPeak,
      silence_ratio AS silenceRatio, hotwords_json AS hotwordsJson, user_edited AS userEdited,
      correction_source AS correctionSource, corrected_at AS correctedAt,
      stability_status AS stabilityStatus, stable_revision AS stableRevision,
      quality_status AS qualityStatus
    FROM transcripts
    WHERE id = ?
  `).get(result.lastInsertRowid);
  db.close();
  return normalizeTranscriptRow(row);
}

export function normalizeTranscriptDraftTimeline(meetingId, drafts, quality = {}, openDb) {
  if (!Array.isArray(drafts) || !drafts.length) return [];
  let cursor = 0;
  try {
    const db = openDb();
    cursor = Number(db.prepare(`
      SELECT COALESCE(MAX(audio_end_ms), 0) AS audioEndMs
      FROM transcripts
      WHERE meeting_id = ? AND deleted_at IS NULL
    `).get(Number(meetingId || 0))?.audioEndMs || 0);
    db.close();
  } catch (error) {
    console.warn(`[transcript] timeline baseline unavailable meeting=${meetingId}: ${error instanceof Error ? error.message : error}`);
  }

  const fallbackDuration = Math.max(250, Number(quality.durationMs || 0) / Math.max(1, drafts.length));
  return drafts.map((draft) => {
    const rawStart = Number(draft.audioStartMs || 0);
    const rawEnd = Number(draft.audioEndMs || 0);
    const hasExplicitRange = Number.isFinite(rawStart) && Number.isFinite(rawEnd) && rawEnd > rawStart;
    // 上游 SentenceEnd 可能乱序到达。显式时间戳必须原样落回会议音轨，
    // 不能为了让数据库 id 单调而推到 cursor 之后；展示层按 audioStartMs 排序。
    const start = hasExplicitRange ? Math.max(0, rawStart) : cursor;
    const end = hasExplicitRange ? rawEnd : start + fallbackDuration;
    cursor = Math.max(cursor, end);
    return {
      ...draft,
      time: formatMeetingElapsedTime(start / 1000),
      audioStartMs: Math.round(start),
      audioEndMs: Math.round(end),
    };
  });
}

export async function correctTranscriptText({ meetingId, text }, openDb) {
  const original = normalizeTranscriptSegment(text);
  const compact = original.replace(/\s/g, "");

  const db = openDb();
  const meeting = db.prepare(`
    SELECT m.title, m.project_id AS projectId, p.name AS projectName
    FROM meetings m
    JOIN projects p ON p.id = m.project_id
    WHERE m.id = ? AND m.deleted_at IS NULL
  `).get(Number(meetingId || 1));
  const recent = db.prepare(`
    SELECT at_time AS time, text
    FROM transcripts
    WHERE meeting_id = ? AND deleted_at IS NULL
    ORDER BY id DESC
    LIMIT 8
  `).all(Number(meetingId || 1)).reverse();
  const history = db.prepare(`
    SELECT title, items_json AS itemsJson
    FROM history_blocks
    WHERE deleted_at IS NULL
    ORDER BY id
    LIMIT 4
  `).all().map((row) => `${row.title}：${JSON.parse(row.itemsJson).slice(0, 3).join("；")}`);
  const memory = meeting ? db.prepare(`
    SELECT
      facts_json AS factsJson,
      goals_json AS goalsJson,
      topics_json AS topicsJson,
      decisions_json AS decisionsJson
    FROM project_memories pm
    JOIN projects p ON p.id = pm.project_id
    WHERE p.name = ? AND pm.deleted_at IS NULL AND p.deleted_at IS NULL
  `).get(meeting.projectName) : null;
  const glossaryEntries = meeting
    ? getGlossaryEntries(db, { projectId: meeting.projectId }).filter((entry) => entry.enabled)
    : getGlossaryEntries(db).filter((entry) => entry.scope === "global" && entry.enabled);
  db.close();

  const glossaryCorrected = applyGlossaryAliasCorrections(original, glossaryEntries);
  // 短文本跳过 LLM 校正，但仍应用明确的热词错词映射。
  if (!hasAiAccess() || compact.length < 10) return glossaryCorrected || original;

  const glossary = [
    ...(safeParseJson(memory?.factsJson) ?? []),
    ...(safeParseJson(memory?.goalsJson) ?? []),
    ...(safeParseJson(memory?.topicsJson) ?? []),
    ...(safeParseJson(memory?.decisionsJson) ?? []),
  ];
  const correctionContext = buildTranscriptCorrectionContext({
    meeting,
    original,
    recent,
    history,
    memoryGlossary: glossary,
    glossaryEntries,
  });

  const prompt = `
请修正一段中文会议 ASR 最终转写，输出严格 JSON。

规则：
1. 只修正明显的语音识别错字、同音词、项目名、人名、产品名、标点和口语断裂。
2. 不要总结，不要扩写，不要补充原文没有的信息。
3. 不要改变否定/肯定、数字、日期、金额、角色关系和动作方向。
4. 项目名、人名、系统名、业务词优先参考“业务热词”和历史上下文；明显近音错词应修正为业务热词。
5. 保留第一人称、语气和口语表达；只做“转写纠错”，不要变成书面总结。
6. 如果原文很短、含糊或无法判断，原样返回。
7. 对“约假/亲家/靠亲/航路权限/某码”等明显不像业务语境的词，要结合热词优先判断是否为“育儿假/请假/考勤/行权限/MOMA”。
8. 输出 text 字段即可。

会议：${meeting?.title || "当前会议"}
项目：${meeting?.projectName || "当前项目"}

近期已确认转写：
${recent.map((line) => `${line.time} ${line.text}`).join("\n") || "暂无"}

历史上下文关键词：
${history.join("\n") || "暂无"}

项目记忆关键词：
${correctionContext.glossary.join("、") || "暂无"}

业务近音纠错示例：
${correctionContext.examples.join("\n") || "暂无"}

待修正原文：
${original}

JSON schema:
{"text":"修正后的同一句话"}
`.trim();

  try {
    const response = await callChatCompletion({
      model: AIT_TRANSCRIPT_CORRECTION_MODEL,
      messages: [
        { role: "system", content: "你是中文会议 ASR 纠错器，只输出合法 JSON，不做总结。" },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 520,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });
    if (!response.ok) return original;
    const payload = JSON.parse(response.text);
    const content = payload?.choices?.[0]?.message?.content || "";
    const corrected = applyGlossaryAliasCorrections(normalizeTranscriptSegment(parseJsonContent(content).text), glossaryEntries);
    if (!isUsableTranscriptCorrection(original, corrected)) {
      return isUsableTranscriptCorrection(original, glossaryCorrected) ? glossaryCorrected : original;
    }
    return corrected;
  } catch {
    return isUsableTranscriptCorrection(original, glossaryCorrected) ? glossaryCorrected : original;
  }
}

export function getLatestTranscriptId(meetingId, openDb) {
  const db = openDb();
  const row = db.prepare(`
    SELECT id FROM transcripts
    WHERE meeting_id = ? AND deleted_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(Number(meetingId || 0));
  db.close();
  return Number(row?.id || 0);
}

export function loadRollingResumeAudio(meetingId, sourceAudioState, sessionAudioBaseMs, openDb) {
  const fallback = {
    pcm: Buffer.alloc(0),
    startMs: Math.max(0, Number(sessionAudioBaseMs || 0)),
    commitEndMs: Math.max(0, Number(sessionAudioBaseMs || 0)),
    hasPreviousWindow: false,
  };
  if (!ROLLING_ASR_ENABLED || !sourceAudioState?.audioPath || !fs.existsSync(sourceAudioState.audioPath)) return fallback;
  try {
    const db = openDb();
    const lastWindowEndMs = Number(db.prepare(`
      SELECT COALESCE(MAX(window_end_ms - trim_trailing_ms), 0) AS windowEndMs
      FROM asr_window_runs
      WHERE meeting_id = ? AND deleted_at IS NULL AND status = 'applied'
    `).get(Number(meetingId || 0))?.windowEndMs || 0);
    db.close();
    const availableBytes = Math.max(0, Number(sourceAudioState.bytes || 0));
    const availableEndMs = Math.round(availableBytes / (16000 * 2) * 1000);
    if (!availableBytes || availableEndMs <= lastWindowEndMs) return fallback;
    // 已完成窗口保留 8 秒重叠；发版/进程重启后从最后窗口尾部向前回填，
    // 让断线期间尚未来得及提交的完整录音重新进入文件 ASR，而不是形成缺口。
    const resumeStartMs = lastWindowEndMs > 0
      ? Math.max(0, lastWindowEndMs - ROLLING_ASR_OVERLAP_SECONDS * 1000)
      : 0;
    let startByte = Math.max(0, Math.round(resumeStartMs * 16000 * 2 / 1000));
    startByte -= startByte % 2;
    const endByte = Math.min(availableBytes, Math.round(Number(sessionAudioBaseMs || availableEndMs) * 16000 * 2 / 1000));
    if (endByte <= startByte) return fallback;
    const pcm = Buffer.allocUnsafe(endByte - startByte);
    const fd = fs.openSync(sourceAudioState.audioPath, "r");
    try {
      fs.readSync(fd, pcm, 0, pcm.length, WAV_HEADER_BYTES + startByte);
    } finally {
      fs.closeSync(fd);
    }
    return {
      pcm,
      startMs: Math.round(startByte / (16000 * 2) * 1000),
      commitEndMs: lastWindowEndMs,
      hasPreviousWindow: lastWindowEndMs > 0,
    };
  } catch (error) {
    console.error(`[rolling-asr] resume preload failed meeting=${meetingId}: ${error instanceof Error ? error.message : error}`);
    return fallback;
  }
}

export function ensureMeetingSourceAudio(meetingId, options = {}, openDb) {
  const key = Number(meetingId || 0);
  const audioPath = getMeetingSourceAudioPath(key);
  if (!fs.existsSync(audioPath)) {
    fs.writeFileSync(audioPath, wrapPcm16AsWav(Buffer.alloc(0), 16000));
  }
  const stat = fs.statSync(audioPath);
  const bytes = Math.max(0, Number(stat.size || 0) - WAV_HEADER_BYTES);
  const existing = meetingSourceAudioWrites.get(key);
  const state = existing && existing.audioPath === audioPath
    ? existing
    : { audioPath, bytes, scheduledBytes: bytes, chain: Promise.resolve(), failed: false };
  state.bytes = Math.max(Number(state.bytes || 0), bytes);
  state.scheduledBytes = Math.max(Number(state.scheduledBytes ?? state.bytes ?? 0), state.bytes);
  meetingSourceAudioWrites.set(key, state);
  const db = openDb();
  // 只有建立新的录音连接时才重新标记为 recording。普通读取/封存调用不会
  // 改写状态；这样同一会议暂停后恢复时，页面不会仍显示 complete。
  const existingStatus = db.prepare("SELECT source_audio_status AS status FROM meetings WHERE id = ? AND deleted_at IS NULL").get(key)?.status;
  const newStatus = options.markRecording
    ? "recording"
    : (existingStatus || "recording");
  db.prepare(`
    UPDATE meetings
    SET source_audio_path = ?, source_audio_bytes = ?, source_audio_duration_ms = ?, source_audio_status = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(audioPath, state.bytes, Math.round(state.bytes / (16000 * 2) * 1000), newStatus, key);
  db.close();
  return state;
}

export async function checkpointMeetingSourceAudio(meetingId, status = "partial", openDb) {
  const key = Number(meetingId || 0);
  const state = meetingSourceAudioWrites.get(key) || ensureMeetingSourceAudio(key);
  try {
    await state.chain;
  } catch (error) {
    state.failed = true;
    console.error(`[source-audio] checkpoint write failed meeting=${key}: ${error instanceof Error ? error.message : error}`);
  }
  const stat = fs.existsSync(state.audioPath) ? fs.statSync(state.audioPath) : { size: WAV_HEADER_BYTES };
  const bytes = Math.max(0, Number(stat.size || 0) - WAV_HEADER_BYTES);
  updateWavFileHeader(state.audioPath, bytes);
  state.bytes = bytes;
  state.scheduledBytes = Math.max(Number(state.scheduledBytes || 0), bytes);
  const durationMs = Math.round(bytes / (16000 * 2) * 1000);
  const checkpointStatus = state.failed
    ? "error"
    : (meetingLiveConnections.has(key) ? "recording" : status);
  const db = openDb();
  db.prepare(`
    UPDATE meetings
    SET source_audio_path = ?, source_audio_bytes = ?, source_audio_duration_ms = ?,
      source_audio_status = ?, elapsed_seconds = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(state.audioPath, bytes, durationMs, checkpointStatus, Math.floor(durationMs / 1000), key);
  db.close();
  return { audioPath: state.audioPath, bytes, durationMs, status: checkpointStatus };
}

export async function finalizeMeetingSourceAudio(meetingId, status = "complete", openDb) {
  const key = Number(meetingId || 0);
  const state = meetingSourceAudioWrites.get(key) || ensureMeetingSourceAudio(key);
  try {
    await state.chain;
  } catch (error) {
    state.failed = true;
    console.error(`[source-audio] write failed meeting=${key}: ${error instanceof Error ? error.message : error}`);
  }
  const stat = fs.existsSync(state.audioPath) ? fs.statSync(state.audioPath) : { size: WAV_HEADER_BYTES };
  const bytes = Math.max(0, Number(stat.size || 0) - WAV_HEADER_BYTES);
  state.bytes = bytes;
  state.scheduledBytes = bytes;
  updateWavFileHeader(state.audioPath, bytes);
  // 暂停后继续录音时，前一条连接的异步 seal 可能晚于新连接启动。
  // 这时绝不能把仍在录音的会议写成 complete；新连接会在真正 stop 时收口。
  const finalStatus = state.failed ? "error" : (meetingLiveConnections.has(key) ? "recording" : status);
  const db = openDb();
  db.prepare(`
    UPDATE meetings
    SET source_audio_path = ?, source_audio_bytes = ?, source_audio_duration_ms = ?,
      source_audio_status = ?, elapsed_seconds = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(
    state.audioPath,
    bytes,
    Math.round(bytes / (16000 * 2) * 1000),
    finalStatus,
    Math.floor(bytes / (16000 * 2)),
    key,
  );
  clampMeetingTranscriptTimeline(db, key, Math.round(bytes / (16000 * 2) * 1000));
  db.close();
  // finalize 后无论 complete 还是 partial 都清理内存中的写入状态，避免 Map 泄漏
  meetingSourceAudioWrites.delete(key);
  return { audioPath: state.audioPath, bytes, durationMs: Math.round(bytes / (16000 * 2) * 1000), status: finalStatus };
}

export function persistMeetingElapsedSeconds(meetingId, seconds, openDb) {
  const db = openDb();
  // elapsed_seconds 是源音频时长的展示缓存，不是另一个累计时钟。允许用
  // 实际音频长度纠正历史版本曾经重复累加出的错误值。
  db.prepare("UPDATE meetings SET elapsed_seconds = ? WHERE id = ?")
    .run(Math.max(0, Math.floor(Number(seconds || 0))), Number(meetingId || 0));
  db.close();
}

