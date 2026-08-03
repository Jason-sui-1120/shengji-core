/**
 * live-asr-helpers.mjs —— 实时 ASR 辅助函数（两端共用）。
 * 源音频管理/转写处理/滚动恢复/会后封存。
 * DB 相关函数接收 db 参数（openDb() 结果），由调用方注入。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { audioDir } from "./env.mjs";
import { wrapPcm16AsWav, getWavDurationSeconds, sliceWavBySeconds } from "./audio-utils.mjs";

/**
 * 格式化音频偏移量（毫秒 → "HH:MM:SS" 或 "MM:SS"）。
 * @param {number} milliseconds - 毫秒数
 * @returns {string} 格式化后的时长字符串
 */
export function formatAudioOffset(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
import { normalizeTranscriptSegment } from "./text-utils.mjs";
import { applyGlossaryAliasCorrections } from "./glossary-text.mjs";
import { identifySpeakerFromAudio } from "./speakers.mjs";
import { formatMeetingElapsedTime } from "./file-segments.mjs";
import { getGlossaryEntries } from "./glossary-query.mjs";

// 拆分自端侧 index.mjs 时的调优常量。本模块不能 import 端侧 config（两端配置
// 来源不同），此处与两端 config.mjs 默认值保持一致；需要调参时再改成注入。
const ASR_MIN_STABLE_CHARS = 10;
const ROLLING_ASR_ENABLED = true;
const ROLLING_ASR_OVERLAP_SECONDS = 8;
const SPEAKER_DIARIZATION_MIN_TEXT_LENGTH = 4;
const WAV_HEADER_BYTES = 44;

// 源音频写入状态（原公网端 index.mjs 模块级 Map，随拆分迁移至此）。
const meetingSourceAudioWrites = new Map();

let audioDirEnsured = false;
function ensureAudioDir() {
  if (audioDirEnsured) return;
  fs.mkdirSync(audioDir, { recursive: true });
  audioDirEnsured = true;
}

function getMeetingSourceAudioPath(meetingId) {
  ensureAudioDir();
  return path.join(audioDir, `meeting-${Number(meetingId || 0)}-source.wav`);
}

function updateWavFileHeader(audioPath, pcmBytes) {
  const bytes = Math.max(0, Number(pcmBytes || 0));
  const header = wrapPcm16AsWav(Buffer.alloc(0), 16000).subarray(0, WAV_HEADER_BYTES);
  header.writeUInt32LE(36 + bytes, 4);
  header.writeUInt32LE(bytes, 40);
  let fd = 0;
  try {
    fd = fs.openSync(audioPath, "r+");
    fs.writeSync(fd, header, 0, header.length, 0);
  } catch (error) {
    console.error(`[audio] header update failed path=${audioPath}: `, error);
  } finally {
    if (fd) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function getUsableDiarizationSegments(segments, text, wav) {
  const compactLength = String(text || "").replace(/\s/g, "").length;
  if (compactLength < SPEAKER_DIARIZATION_MIN_TEXT_LENGTH) return [];
  if (!Array.isArray(segments) || segments.length < 2) return [];
  const speakers = new Set(segments.map((segment) => segment.speaker));
  if (speakers.size < 2) return [];
  const duration = getWavDurationSeconds(wav);
  if (duration && segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0) < duration * 0.45) return [];
  return segments.slice(0, 6);
}

function splitTranscriptClauses(text) {
  const matches = String(text || "").match(/[^。！？!?；;，,]+[。！？!?；;，,]?/g) || [];
  return matches.map((part) => part.trim()).filter(Boolean);
}

function findTextSplitBoundary(text, target, minIndex) {
  const punctuation = "。！？!?；;，,";
  const start = Math.max(minIndex + 1, target - 12);
  const end = Math.min(text.length - 1, target + 12);
  for (let radius = 0; radius <= 12; radius += 1) {
    const right = target + radius;
    if (right <= end && punctuation.includes(text[right])) return right + 1;
    const left = target - radius;
    if (left >= start && punctuation.includes(text[left])) return left + 1;
  }
  return Math.max(minIndex + 1, Math.min(text.length - 1, target));
}

function splitTextByDurationRatio(text, segments) {
  const compact = String(text || "").trim();
  if (!compact) return [];
  const totalDuration = segments.reduce((sum, segment) => sum + Math.max(0.1, segment.end - segment.start), 0);
  const parts = [];
  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    if (index === segments.length - 1) {
      parts.push(compact.slice(cursor));
      break;
    }
    const ratio = (segments[index].end - segments[index].start) / totalDuration;
    const target = Math.max(cursor + 1, Math.round(cursor + compact.length * ratio));
    const boundary = findTextSplitBoundary(compact, target, cursor);
    parts.push(compact.slice(cursor, boundary));
    cursor = boundary;
  }
  return parts.map(normalizeTranscriptSegment).filter(Boolean);
}

function splitTranscriptTextByDiarization(text, segments) {
  const segmentTexts = segments.map((segment) => normalizeTranscriptSegment(segment.text || ""));
  if (
    segmentTexts.length === segments.length &&
    segmentTexts.filter(Boolean).length === segments.length &&
    segmentTexts.join("").replace(/\s/g, "").length >= String(text || "").replace(/\s/g, "").length * 0.55
  ) {
    return segmentTexts;
  }

  const clauses = splitTranscriptClauses(text);
  if (clauses.length < segments.length) return splitTextByDurationRatio(text, segments);

  const totalDuration = segments.reduce((sum, segment) => sum + Math.max(0.1, segment.end - segment.start), 0);
  const totalChars = clauses.reduce((sum, clause) => sum + clause.length, 0) || text.length;
  const parts = [];
  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    if (index === segments.length - 1) {
      parts.push(clauses.slice(cursor).join(""));
      break;
    }
    const targetChars = Math.round(((segments[index].end - segments[index].start) / totalDuration) * totalChars);
    let take = 0;
    let chars = 0;
    while (cursor + take < clauses.length && (take === 0 || chars < targetChars)) {
      chars += clauses[cursor + take].length;
      take += 1;
    }
    parts.push(clauses.slice(cursor, cursor + take).join(""));
    cursor += take;
  }
  return parts.map(normalizeTranscriptSegment).filter(Boolean);
}

function offsetTimeLabel(timeLabel, offsetSeconds) {
  const match = String(timeLabel || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return timeLabel;
  const hasSeconds = Boolean(match[3]);
  const baseSeconds = hasSeconds
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : Number(match[1]) * 3600 + Number(match[2]) * 60;
  const next = Math.max(0, baseSeconds + Math.round(Number(offsetSeconds || 0)));
  if (hasSeconds) {
    const h = Math.floor(next / 3600) % 24;
    const m = Math.floor((next % 3600) / 60);
    const sec = next % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  const h = Math.floor(next / 3600) % 24;
  const m = Math.floor((next % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function safeParseJsonLocal(value) {
  try { return JSON.parse(value); } catch { return null; }
}

// 转写行的读出规整（原公网端 index.mjs 同名函数，随拆分迁移至此）。
function normalizeTranscriptRow(row) {
  if (!row) return row;
  return {
    ...row,
    focus: Boolean(row.focus),
    correctionApplied: Boolean(row.correctionApplied),
    userEdited: Boolean(row.userEdited),
    stabilityStatus: row.stabilityStatus || "stable",
    qualityStatus: row.qualityStatus || (row.stabilityStatus === "stable" ? "unknown" : "realtime"),
    stableRevision: Number(row.stableRevision || 0),
    hotwords: safeParseJsonLocal(row.hotwordsJson) ?? [],
    asrQuality: {
      durationMs: Number(row.audioDurationMs || 0),
      audioBytes: Number(row.audioBytes || 0),
      rms: Number(row.audioRms || 0),
      peak: Number(row.audioPeak || 0),
      silenceRatio: Number(row.silenceRatio || 0),
    },
    hotwordsJson: undefined,
  };
}

// 从 AI 返回文本中提取 JSON（原端侧 index.mjs 同名函数，随拆分迁移至此）。
function parseJsonContent(content) {
  const cleaned = String(content || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI did not return JSON");
    return JSON.parse(match[0]);
  }
}

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

/** @sqlite 需要 openDb 参数（SQLite 实现） */
export function savePcmAsWav(pcmChunks, meetingId) {
  const pcm = Buffer.concat(pcmChunks.filter((chunk) => Buffer.isBuffer(chunk) && chunk.length));
  if (!pcm.length) return { audioPath: "", wav: null };
  const wav = wrapPcm16AsWav(pcm, 16000);
  const fileName = `meeting-${Number(meetingId || 1)}-${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
  ensureAudioDir();
  const audioPath = path.join(audioDir, fileName);
  fs.writeFileSync(audioPath, wav);
  return { audioPath, wav };
}

/** @sqlite 需要 openDb 参数（SQLite 实现） */
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

/** @sqlite 需要 openDb 参数（SQLite 实现） */
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
    timelineChapters: safeParseJsonLocal(saved.timelineChaptersJson) ?? [],
    quoteMoments: safeParseJsonLocal(saved.quoteMomentsJson) ?? [],
    speakerViewpoints: safeParseJsonLocal(saved.speakerViewpointsJson) ?? [],
    transcriptCount: saved.transcriptCount,
    sourceRevision: Number(saved.sourceRevision || 0),
    createdAt: saved.createdAt,
  };
}

/** @sqlite 需要 openDb 参数（SQLite 实现） */
export function getMeetingLiveRecord(meetingId, openDb) {
  const db = openDb();
  const row = db.prepare("SELECT id, status, deleted_at AS deletedAt FROM meetings WHERE id = ?").get(Number(meetingId || 0));
  db.close();
  return row || null;
}

/** @sqlite 需要 openDb 参数（SQLite 实现） */
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

/** @sqlite 需要 openDb 参数（SQLite 实现） */
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
    ...(safeParseJsonLocal(memory?.factsJson) ?? []),
    ...(safeParseJsonLocal(memory?.goalsJson) ?? []),
    ...(safeParseJsonLocal(memory?.topicsJson) ?? []),
    ...(safeParseJsonLocal(memory?.decisionsJson) ?? []),
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

/** @sqlite 需要 openDb 参数（SQLite 实现） */
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
    console.error(`[rolling-asr] resume preload failed meeting=${meetingId}: `, error);
    return fallback;
  }
}

/** @sqlite 需要 openDb 参数（SQLite 实现） */
export function ensureMeetingSourceAudio(meetingId, options = {}, openDb) {
  const key = Number(meetingId || 0);
  const audioPath = getMeetingSourceAudioPath(key);
  const db = openDb();

  // 服务重启后优先从数据库恢复已持久化字节数——音频文件可能丢失（data/audio 被清理），
  // 但数据库的 source_audio_bytes 是权威记录（每次 append 都会 UPDATE）。
  // 文件 stat 只作兜底（数据库无记录时）。
  const dbRow = db.prepare("SELECT source_audio_bytes AS bytes FROM meetings WHERE id = ? AND deleted_at IS NULL").get(key);
  const dbBytes = Math.max(0, Number(dbRow?.bytes || 0));

  if (!fs.existsSync(audioPath)) {
    fs.writeFileSync(audioPath, wrapPcm16AsWav(Buffer.alloc(0), 16000));
  }
  const stat = fs.statSync(audioPath);
  const fileBytes = Math.max(0, Number(stat.size || 0) - WAV_HEADER_BYTES);

  // 取数据库与文件的较大值——数据库记录通常更新（文件可能丢失后被重建为空文件）。
  const bytes = Math.max(dbBytes, fileBytes);

  const existing = meetingSourceAudioWrites.get(key);
  const state = existing && existing.audioPath === audioPath
    ? existing
    : { audioPath, bytes, scheduledBytes: bytes, chain: Promise.resolve(), failed: false };
  state.bytes = Math.max(Number(state.bytes || 0), bytes);
  state.scheduledBytes = Math.max(Number(state.scheduledBytes ?? state.bytes ?? 0), state.bytes);
  meetingSourceAudioWrites.set(key, state);
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

// meetingLiveConnections 不是所有端都注入（公网端用 live-asr-helpers 直连，公司端 Adapter 覆盖）——
// 用 typeof 安全检测，不存在则直接用 status 参数（pause/resume 防误标记由端侧实现负责）。
const _liveConns = typeof meetingLiveConnections !== "undefined" ? meetingLiveConnections : null;

export async function checkpointMeetingSourceAudio(meetingId, status = "partial", openDb) {
  const key = Number(meetingId || 0);
  const state = meetingSourceAudioWrites.get(key) || ensureMeetingSourceAudio(key);
  try {
    await state.chain;
  } catch (error) {
    state.failed = true;
    console.error(`[source-audio] checkpoint write failed meeting=${key}: `, error);
  }
  const stat = fs.existsSync(state.audioPath) ? fs.statSync(state.audioPath) : { size: WAV_HEADER_BYTES };
  const bytes = Math.max(0, Number(stat.size || 0) - WAV_HEADER_BYTES);
  updateWavFileHeader(state.audioPath, bytes);
  state.bytes = bytes;
  state.scheduledBytes = Math.max(Number(state.scheduledBytes || 0), bytes);
  const durationMs = Math.round(bytes / (16000 * 2) * 1000);
  // meetingLiveConnections 不是所有端都注入（公网端用 live-asr-helpers 直连，公司端 Adapter 覆盖）——
  const checkpointStatus = state.failed
    ? "error"
    : (_liveConns && _liveConns.has(key) ? "recording" : status);
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

function clampMeetingTranscriptTimeline(db, meetingId, durationMs) {
  const total = Math.max(0, Number(durationMs || 0));
  if (!total) return;
  const rows = db.prepare(`
    SELECT id, audio_start_ms AS audioStartMs, audio_end_ms AS audioEndMs,
      audio_duration_ms AS audioDurationMs, user_edited AS userEdited
    FROM transcripts
    WHERE meeting_id = ? AND deleted_at IS NULL
    ORDER BY CASE WHEN audio_end_ms > audio_start_ms THEN audio_start_ms ELSE 9223372036854775807 END, id
  `).all(Number(meetingId || 0));
  if (!rows.length) return;
  const update = db.prepare("UPDATE transcripts SET audio_start_ms = ?, audio_end_ms = ? WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL");
  const discard = db.prepare("UPDATE transcripts SET deleted_at = ? WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL AND user_edited = 0");
  let cursor = 0;
  for (const row of rows) {
    const originalStart = Number(row.audioStartMs || 0);
    const originalEnd = Number(row.audioEndMs || 0);
    const estimated = Math.max(250, Number(row.audioDurationMs || 0));
    let start = Math.min(total, Math.max(cursor, Math.max(0, Number.isFinite(originalStart) ? originalStart : 0)));
    let end = Number.isFinite(originalEnd) && originalEnd > start
      ? Math.min(total, originalEnd)
      : Math.min(total, start + estimated);
    if (end <= start) end = Math.min(total, start + estimated);
    if (start > total) { discard.run(new Date().toISOString(), row.id, Number(meetingId || 0)); continue; }
    if (start !== originalStart || end !== originalEnd) update.run(start, end, row.id, Number(meetingId || 0));
    cursor = end;
  }
}

export async function finalizeMeetingSourceAudio(meetingId, status = "complete", openDb) {
  const key = Number(meetingId || 0);
  const state = meetingSourceAudioWrites.get(key) || ensureMeetingSourceAudio(key);
  try {
    await state.chain;
  } catch (error) {
    state.failed = true;
    console.error(`[source-audio] write failed meeting=${key}: `, error);
  }
  const stat = fs.existsSync(state.audioPath) ? fs.statSync(state.audioPath) : { size: WAV_HEADER_BYTES };
  const bytes = Math.max(0, Number(stat.size || 0) - WAV_HEADER_BYTES);
  state.bytes = bytes;
  state.scheduledBytes = bytes;
  updateWavFileHeader(state.audioPath, bytes);
  // 暂停后继续录音时，前一条连接的异步 seal 可能晚于新连接启动。
  // 这时绝不能把仍在录音的会议写成 complete；新连接会在真正 stop 时收口。
  const finalStatus = state.failed ? "error" : (_liveConns && _liveConns.has(key) ? "recording" : status);
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

