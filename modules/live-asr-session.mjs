/**
 * live-asr-session.mjs —— 实时 ASR 会话（两端共用）。
 * WebSocket 实时转写核心：上游连接管理、PCM 缓冲、转写推送、滚动窗口调度、
 * 断线恢复、失败重试、会后封存。
 *
 * 通过 deps 注入端侧差异（DB 方言/鉴权/配置/存储），业务逻辑两端统一。
 */
import { wrapPcm16AsWav } from "./audio-utils.mjs";

/**
 * 计算上游重连策略。
 *
 * AIT 对同一 key 的流式 ASR 任务会在 close 后保留一段释放时间。若在这段时间
 * 内以秒级频率重连，只会不断收到 1009（too many connections），既耗尽重试又让
 * 用户误以为录音丢失。计划轮换和并发受限都必须等待足够长的冷却期；完整音频与
 * 45 秒文件 ASR 在此期间仍持续工作。
 */
export function getUpstreamReconnectPlan(reason = "upstream closed", attempt = 1, config = {}) {
  const normalizedReason = String(reason || "upstream closed");
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  const isPlannedRotation = /planned_task_rotation/i.test(normalizedReason);
  const isConcurrencyLimit = /too many connections|\b1009\b|\b1011\b|internal error/i.test(normalizedReason);
  const rotationCooldownMs = Math.max(1_000, Number(config.ASR_UPSTREAM_ROTATION_COOLDOWN_MS || 35_000));
  const concurrencyBaseMs = Math.max(1_000, Number(config.ASR_CONCURRENCY_RETRY_BASE_MS || 30_000));
  const concurrencyMaxMs = Math.max(concurrencyBaseMs, Number(config.ASR_CONCURRENCY_RETRY_MAX_MS || 90_000));

  if (isPlannedRotation) {
    return { delay: rotationCooldownMs, isPlannedRotation, isConcurrencyLimit };
  }
  if (isConcurrencyLimit) {
    return {
      delay: Math.min(concurrencyBaseMs * normalizedAttempt, concurrencyMaxMs),
      isPlannedRotation,
      isConcurrencyLimit,
    };
  }
  return {
    delay: Math.min(800 * 2 ** Math.min(normalizedAttempt - 1, 4), 8_000),
    isPlannedRotation,
    isConcurrencyLimit,
  };
}

/**
 * 流式 ASR 在一句话尚未结束时，可能先以 partial-progress 落一段前缀，
 * 随后又把几乎相同的 SentenceEnd 作为完整结果发回来；少数上游任务还会
 * 重发相邻的 SentenceEnd。这里仅压制“同一段的近似重发”，绝不按文字全局
 * 去重，避免删掉真实的重复发言。
 */
export function shouldSuppressLiveTranscriptDuplicate(previous, current, options = {}) {
  if (!previous?.text || !current?.text) return false;
  const compact = (value) => String(value || "").replace(/[\s，,。！？!?；;：:、]/g, "");
  const previousText = compact(previous.text);
  const currentText = compact(current.text);
  if (!previousText || !currentText) return false;

  const shorter = previousText.length <= currentText.length ? previousText : currentText;
  const longer = previousText.length <= currentText.length ? currentText : previousText;
  const sharedPrefix = (() => {
    let index = 0;
    while (index < shorter.length && shorter[index] === longer[index]) index += 1;
    return index;
  })();
  // 至少 8 个字、且覆盖短文本 80%，同时只允许很小的尾部差异。
  const closeText = shorter.length >= 8
    && sharedPrefix >= 8
    && sharedPrefix / shorter.length >= 0.8
    && longer.length - shorter.length <= Math.max(4, Math.ceil(longer.length * 0.25));
  if (!closeText) return false;

  const previousStart = Number(previous.audioStartMs || 0);
  const previousEnd = Number(previous.audioEndMs || previousStart);
  const currentStart = Number(current.audioStartMs || 0);
  const currentEnd = Number(current.audioEndMs || currentStart);
  const overlapMs = Math.max(0, Math.min(previousEnd, currentEnd) - Math.max(previousStart, currentStart));
  const shorterDuration = Math.min(Math.max(0, previousEnd - previousStart), Math.max(0, currentEnd - currentStart));
  const overlapRatio = shorterDuration > 0 ? overlapMs / shorterDuration : 0;
  const gapMs = Math.max(0, currentStart - previousEnd, previousStart - currentEnd);

  // partial-progress 的时间端点来自本地时钟，SentenceEnd 的端点来自上游；
  // 二者可相差一个短句时长。只在前一个确为 partial-progress 时放宽到 10 秒。
  const ordinaryDuplicate = overlapRatio > 0.8 || gapMs <= 1_500;
  const progressFinalDuplicate = previous.reason === "partial_progress" && gapMs <= 10_000;
  return ordinaryDuplicate || progressFinalDuplicate || options.force === true;
}

/**
 * 火山 LM 的 partial 是“从当前上游句首到现在”的累计快照，而不是增量。
 * 浏览器 VAD 的短暂停顿不代表上游已经开启新句，不能据此清空累计游标。
 * 这里把已经持久化的累计前缀从新快照中裁掉，只返回尚未落轴的文本。
 */
export function getUncommittedCumulativeText(committedText, candidateText) {
  const committed = String(committedText || "");
  const candidate = String(candidateText || "");
  const hasSpeechText = (value) => Boolean(String(value || "").replace(/[\s，,。！？!?；;：:、]/g, ""));
  if (!candidate) return "";
  if (!committed) return candidate;
  if (candidate.startsWith(committed)) {
    const suffix = candidate.slice(committed.length);
    return hasSpeechText(suffix) ? suffix : "";
  }
  if (committed.startsWith(candidate)) return "";

  // 允许上游在最终快照中轻微调整空格或标点。比较时忽略这些字符，
  // 但通过索引映射仍从原候选文本的正确位置裁切。
  const compactWithMap = (value) => {
    const compact = [];
    const sourceIndexes = [];
    for (let index = 0; index < value.length; index += 1) {
      if (/[\s，,。！？!?；;：:、]/.test(value[index])) continue;
      compact.push(value[index]);
      sourceIndexes.push(index);
    }
    return { text: compact.join(""), sourceIndexes };
  };
  const left = compactWithMap(committed);
  const right = compactWithMap(candidate);
  const shorterLength = Math.min(left.text.length, right.text.length);
  let sharedPrefix = 0;
  while (sharedPrefix < shorterLength && left.text[sharedPrefix] === right.text[sharedPrefix]) sharedPrefix += 1;
  let committedThroughCandidateIndex = sharedPrefix - 1;
  // 忽略标点后，候选完整包含全部已提交文本时可直接裁尾；只要已提交文本
  // 尚未全部匹配，就必须继续走回改对齐，不能因为前 80% 相同而提前截断。
  if (sharedPrefix < left.text.length) {
    // 流式模型会回改累计快照中间的少量同音词，严格 startsWith 会把这种
    // “旧前缀 + 新尾部”误判为全新句。用受限编辑距离把“全部已提交文字”
    // 对齐到候选的最佳前缀；只在差异很小且开头锚点一致时裁尾，避免把
    // 真正的新一句错当成旧句续写。实时 partial 通常不超过几百字，矩阵有明确上限。
    const maxAlignmentChars = 320;
    if (!left.text || !right.text || left.text.length > maxAlignmentChars || right.text.length > maxAlignmentChars) return candidate;
    const anchorLength = Math.min(6, left.text.length, right.text.length);
    const sameOpeningAnchor = anchorLength >= 4 && left.text.slice(0, anchorLength) === right.text.slice(0, anchorLength);
    if (!sameOpeningAnchor) return candidate;
    let previousRow = Uint16Array.from({ length: right.text.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.text.length; leftIndex += 1) {
      const currentRow = new Uint16Array(right.text.length + 1);
      currentRow[0] = leftIndex;
      for (let rightIndex = 1; rightIndex <= right.text.length; rightIndex += 1) {
        const substitutionCost = left.text[leftIndex - 1] === right.text[rightIndex - 1] ? 0 : 1;
        currentRow[rightIndex] = Math.min(
          previousRow[rightIndex] + 1,
          currentRow[rightIndex - 1] + 1,
          previousRow[rightIndex - 1] + substitutionCost,
        );
      }
      previousRow = currentRow;
    }
    const minCandidatePrefix = Math.max(anchorLength, Math.floor(left.text.length * 0.7));
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestCandidateLength = 0;
    for (let candidateLength = minCandidatePrefix; candidateLength <= right.text.length; candidateLength += 1) {
      const distance = Number(previousRow[candidateLength]);
      if (distance < bestDistance || (distance === bestDistance && candidateLength > bestCandidateLength)) {
        bestDistance = distance;
        bestCandidateLength = candidateLength;
      }
    }
    // 当前游标只在同一个 upstream 句子内存活，SentenceEnd 会立即重置；因此
    // 同开头锚点且候选明显延长时，可以容忍模型对口语长句做较多回改。
    if (!bestCandidateLength || bestDistance / left.text.length > 0.35) return candidate;
    committedThroughCandidateIndex = bestCandidateLength - 1;
  }
  if (right.text.length <= committedThroughCandidateIndex + 1) return "";
  const rawCutIndex = Number(right.sourceIndexes[committedThroughCandidateIndex] ?? -1) + 1;
  const suffix = candidate.slice(rawCutIndex);
  return hasSpeechText(suffix) ? suffix : "";
}

export async function createLiveAsrSession(client, clientUrl, deps) {
  // 这个模块同时运行在 SQLite 公网端和 MySQL 公司端，不能再隐式读取宿主
  // index.mjs 的全局变量。所有 Node 运行时对象和端侧状态都必须显式注入。
  const WebSocket = deps.WebSocket;
  const Buffer = deps.Buffer;
  const randomUUID = deps.randomUUID;
  const meetingLiveConnections = deps.meetingConnections;
  const config = {
    ASR_UPSTREAM_MAX_SENTENCE_SILENCE: 1_200,
    ASR_PENDING_AUDIO_MAX_BYTES: 4 * 1024 * 1024,
    ASR_FINAL_STABILITY_DELAY_MS: 400,
    // 与两端 config.mjs 的调优值对齐（拆分前的实际行为）：不完整句多等 2.5s 再收口，
    // 避免实时稿被切成碎句。
    ASR_SHORT_MERGE_DELAY_MS: 800,
    ASR_INCOMPLETE_MERGE_DELAY_MS: 2_500,
    LIVE_DRAFT_LLM_CORRECTION: false,
    LIVE_SPEAKER_IDENTIFY_INTERVAL_MS: 12_000,
    // 部分上游 ASR 任务在 4 分钟左右会被服务端回收。主动平滑轮换，
    // 避免等到硬断开后再进入重连。关闭旧任务后还会等候服务端释放名额，
    // 再恢复上游，不会以短间隔反复撞 1009。
    ASR_UPSTREAM_ROTATE_AFTER_MS: 210_000,
    ASR_UPSTREAM_ROTATION_COOLDOWN_MS: 35_000,
    ASR_CONCURRENCY_RETRY_BASE_MS: 30_000,
    ASR_CONCURRENCY_RETRY_MAX_MS: 90_000,
    // 上游 LM 模型可能长时间只发 TranscriptionResultChanged 而不发
    // SentenceEnd；实时草稿不能因此一直堆在顶部卡片。达到这个间隔后，
    // 共享会话会把已确认的 partial 前缀落成一条 draft，后续稳定稿再替换它。
    ASR_PARTIAL_PROGRESS_INTERVAL_MS: 5_000,
    ASR_PARTIAL_PROGRESS_MIN_CHARS: 24,
    ASR_PARTIAL_PROGRESS_MAX_CHARS: 120,
    // 词库在会话初始化时异步预热；草稿落库不能等待词库、声纹或 LLM。
    ASR_GLOSSARY_TIMEOUT_MS: 1_500,
    ROLLING_ASR_TIMEOUT_MS: 90_000,
    TAIL_STABILIZATION_TIMEOUT_MS: 60_000,
    POST_MEETING_SPEAKER_TIMEOUT_MS: 15_000,
    ...deps.config,
  };
  if (!WebSocket || !Buffer || !randomUUID || !meetingLiveConnections) {
    throw new Error("live_asr_runtime_dependencies_missing");
  }
  if (!deps.hasAiAccess()) {
    client.send(JSON.stringify({ type: "error", message: "AI gateway or AIT_API_KEY is not configured" }));
    client.close(3000, "missing api key");
    return;
  }

  // init 早退路径的统一清理：防止缓冲 handler / 心跳 / 连接锁泄漏（进程级内存与锁泄漏）。
  let clientPingTimer = null;
  const cleanupEarlyExit = () => {
    preInitFrames.length = 0;
    if (clientPingTimer) clearInterval(clientPingTimer);
    if (meetingLiveConnections.get(meetingId) === client) meetingLiveConnections.delete(meetingId);
  };

  // 初始化期间（多次异步 DB 查询）到达的音频帧不能丢：全部进有序队列，
  // init 完成后先回放队列再放行实时帧。此前 handler 在 await 之后才注册，
  // MySQL 端 init 较慢时首帧丢失会导致 meta/帧错位、整段录音被判 gap 拒绝。
  const preInitFrames = [];
  let replayDone = false;
  client.on("message", (data, isBinary) => {
    if (!replayDone) preInitFrames.push([data, isBinary]);
  });

  // P0：自适应 VAD——方案 1+3（自适应门限 + 迟滞）。
  // 返回 true 表示这一帧是真实语音（应计入 realSpeechAudioBytes）。
  // 与旧 isSilentPcm（写死 500 门限）的区别：
  //   1. 门限自适应——背景噪音 EMA × 系数，远场小声（RMS ~286）也能识别为语音
  //   2. 迟滞——连续 N 帧超门限才确认语音开始，低于更低门限才确认结束，避免抖动
  function isRealSpeechPcm(chunk) {
    if (chunk.length < 2) return false;
    let sum = 0;
    const samples = chunk.length / 2;
    for (let i = 0; i < chunk.length; i += 2) {
      const val = chunk.readInt16LE(i);
      sum += val * val;
    }
    const rms = Math.sqrt(sum / samples);

    const speechThreshold = Math.min(VAD_MAX_THRESHOLD, Math.max(VAD_MIN_THRESHOLD, vadNoiseFloor * VAD_SPEECH_RATIO));
    const silenceThreshold = Math.min(VAD_MAX_THRESHOLD, Math.max(VAD_MIN_THRESHOLD, vadNoiseFloor * VAD_SILENCE_RATIO));

    if (!vadInSpeech) {
      // 未在语音段：连续 N 帧超语音门限才确认开始（防单帧噪音误触发）
      if (rms >= speechThreshold) {
        vadSpeechFrames += 1;
        if (vadSpeechFrames >= VAD_START_FRAMES) {
          vadInSpeech = true;
          vadSpeechFrames = 0;
          // 进入语音段——不更新噪音底（避免语音把噪音底拉高）
          return true;
        }
      } else {
        vadSpeechFrames = 0;
        // 非语音帧——用 EMA 更新背景噪音底（自适应跟踪环境噪音）
        vadNoiseFloor = VAD_NOISE_ALPHA * vadNoiseFloor + (1 - VAD_NOISE_ALPHA) * rms;
      }
      return false;
    }

    // 在语音段：低于静音门限才退出（迟滞上沿 < 语音门限，一句话中间停顿不被切断）
    if (rms < silenceThreshold) {
      vadInSpeech = false;
      vadSpeechFrames = 0;
      // 退出后这一帧视为静音，更新噪音底
      vadNoiseFloor = VAD_NOISE_ALPHA * vadNoiseFloor + (1 - VAD_NOISE_ALPHA) * rms;
      return false;
    }
    return true;
  }

  const meetingId = Number(clientUrl.searchParams.get("meetingId") || 1);
  const liveMeeting = await deps.getMeetingLiveRecord(meetingId);
  const finalizedMeeting = await deps.getFinalizedMeetingByMeetingId(meetingId);
  if (!liveMeeting || liveMeeting.deletedAt || ["finalized", "archived"].includes(String(liveMeeting.status || "").toLowerCase()) || finalizedMeeting) {
    client.send(JSON.stringify({ type: "error", message: "会议已归档或已删除，不能继续建立实时转写连接" }));
    cleanupEarlyExit();
    client.close(1008, "meeting archived or deleted");
    return;
  }

  // 同一会议只允许一个活跃 ASR 连接，避免多连接 rolling correction 互相覆盖
  const existingConnection = meetingLiveConnections.get(meetingId);
  if (existingConnection && existingConnection.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({ type: "error", message: "该会议已有活跃的录音连接，请先结束现有录音" }));
    cleanupEarlyExit();
    client.close(3000, "meeting already has an active connection");
    return;
  }
  meetingLiveConnections.set(meetingId, client);
  // WebSocket 连接建立时把 status 更新为 recording——/api/state 的 getCurrentMeetingForUser
  // 查 status NOT IN ('finalized', 'archived')，找不到正在录音的会议（status 还是 idle）。
  // ensureMeetingSourceAudio 只更新 source_audio_status，不更新 status 字段。
  // P0：await 等待 setMeetingStatus 完成——前端刷新时 WebSocket 断开，status 必须已更新。
  if (typeof deps.setMeetingStatus === "function") {
    try {
      await Promise.resolve(deps.setMeetingStatus(meetingId, "recording"));
    } catch (error) {
      console.error(`[asr/live] set meeting status failed meeting=${meetingId}: `, error);
    }
  }
  // server→client 心跳：浏览器收到 WS ping 会自动回 pong。音频暂停（静音/后台标签页）
  // 时仍有双向流量，防止公司入口网关/nginx 因空闲超时切断长连接（公网 nginx 同理）。
  clientPingTimer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch { /* gone */ }
    }
  }, 25_000);
  // 定期发送当前音频偏移量（累计会议时长）——前端 elapsed 用这个值，
  // 不依赖 /api/state 的 elapsedSeconds（录音过程中不更新，只有 pause/seal 才写）。
  const audioOffsetTimer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) {
      safeSend({
        type: "status",
        status: "audio_offset",
        audioOffsetMs: getTranscriptAudioOffsetMs(),
        upstreamTaskId,
        upstreamOpen,
        upstreamStarted: started,
        pendingAudioBytes,
        sourceAppendQueuedBytes,
        upstreamReconnectAttempt,
      });
    }
  }, 5000);
  // 无用户模型选择 UI——前端不传 model 参数，直接用 AIT_ASR_MODEL 配置（models.json 权威值）。
  // 避免"前端读配置→传回后端→后端再用配置"的循环引用。
  const model = deps.config.AIT_ASR_MODEL;
  const upstreamUrl = deps.getAsrUpstreamUrl(model);
  let upstreamTaskId = randomUUID();
  let upstreamOpen = false;
  let started = false;
  let transcriptBuffer = "";
  let transcriptBufferStartedAt = "";
  let transcriptBufferStartedAudioMs = 0;
  let transcriptBufferEndAudioMs = 0;
  let pendingSpeechStartAt = "";
  let pendingSpeechStartAudioMs = null;
  let latestPartial = "";
  // LM 类模型（huoshanLM）的 TranscriptionResultChanged 是"从句首到当前"的
  // 累积快照，且对英文长句不发 SentenceEnd。vad.endpoint 的兜底 flush 会用
  // latestPartial 落库，若不加抑制会把同一句话的快照反复落库（前缀累积重复行）。
  let lastPartialFlushText = "";
  let lastPartialFlushAudioStartMs = 0;
  let lastFlushedTranscript = null; // { text, audioStartMs, audioEndMs, reason }——仅压制上游的近似重发
  // 用户可见草稿不能长时间停在“待识别”。上游流式 ASR 不提供可靠 speaker，
  // 因此先沿用当前会议轨道（首条为说话人 1），声纹在落库后异步纠正。
  let currentProvisionalSpeaker = "说话人 1";
  let lastSpeakerIdentifyAudioMs = Number.NEGATIVE_INFINITY;
  let speakerEnrichmentChain = Promise.resolve();
  let speechAudioChunks = [];
  let speechAudioBytes = 0;
  // P0：真实语音 PCM 字节数（自适应 VAD 后）——asr_no_first_result 定时器只在有真实语音时启动
  let realSpeechAudioBytes = 0;
  // 方案 1+3：自适应门限（背景噪音 × 系数）+ 迟滞（连续 N 帧确认真语音）——
  // 替代写死的硬门限 500（对远场录音 RMS ~286 太激进，会把真实人声误判为静音）。
  let vadNoiseFloor = 100;          // 背景噪音能量（EMA 自适应，初始保守值——远场环境噪音通常 ~100-200）
  const VAD_NOISE_ALPHA = 0.95;     // 噪音 EMA 平滑系数（越大越慢，越稳）
  const VAD_SPEECH_RATIO = 1.3;     // 语音门限 = 噪音 × 系数（远场小声 RMS ~250 也能识别）
  const VAD_SILENCE_RATIO = 1.1;    // 静音门限 = 噪音 × 系数（迟滞上沿，小于语音门限形成迟滞）
  const VAD_START_FRAMES = 2;       // 连续 2 帧超语音门限才确认"语音开始"（防误触发）
  const VAD_MIN_THRESHOLD = 80;     // 门限下限——极静环境下不误判键盘/呼吸为语音
  const VAD_MAX_THRESHOLD = 2000;   // 门限上限——极吵环境下不漏判小声语音
  let vadSpeechFrames = 0;          // 连续超语音门限的帧数
  let vadInSpeech = false;          // 当前是否处于"语音段"（迟滞状态）
  let pendingAudioChunks = [];
  let pendingAudioBytes = 0;
  let upstream = null;
  let upstreamReconnectTimer = null;
  let upstreamReconnectAttempt = 0;
  let upstreamRotationTimer = null;
  // P0：asr_no_first_result 受控重连上限——达到上限后向用户展示错误，不无限停留
  const ASR_NO_FIRST_RESULT_MAX_RECONNECT = 3;
  let asrNoFirstResultReconnectAttempt = 0;
  let upstreamTaskAudioBaseMs = 0;
  let upstreamTimestampClampCount = 0;
  let upstreamStopped = false;
  let silenceKeepaliveTimer = null;
  let lastAudioSentAt = 0;
  let transcriptFlushTimer = null;
  let transcriptFlushReason = "";
  let partialProgressTimer = null;
  let partialProgressCommittedText = "";
  let partialProgressLastAudioEndMs = 0;
  let rollingAudioChunks = [];
  let rollingAudioBytes = 0;
  let rollingCorrectionRunning = false;
  let rollingCorrectionQueued = false;
  let rollingFinalRequested = false;
  let rollingWindowHasOverlap = false;
  let rollingSpeechIntervals = [];
  let activeRollingSpeech = null;
  let failedRollingWindows = [];
  let rollingRetryRunning = false;
  let rollingRetryTimer = null;
  // 用户点击结束后，所有仍可能触发文件稿落库的路径都必须共享同一个取消信号。
  // 否则第一扇尾窗完成后递归提交的下一扇窗口会脱离 70 秒 deadline，晚于
  // realtime fallback 写入同一时间段，重新造成重复稳定稿。
  let sealingAbortSignal = null;
  let sealingPromise = null;
  let stopRequested = false;
  // 会议时间轴只由已经持久化的 PCM 样本数决定。elapsed_seconds 是展示缓存，
  // 不能再和源 WAV 时长相加，否则暂停/断线后恢复会把旧时长重复计算。
  // P0：Adapter 可能返回 Promise（公司端 async），core 统一 await Promise.resolve。
  const sourceAudioState = await Promise.resolve(deps.ensureMeetingSourceAudio(meetingId, { markRecording: true }));
  const sessionAudioBaseBytes = Math.max(0, Number(sourceAudioState.scheduledBytes ?? sourceAudioState.bytes ?? 0));
  const sessionAudioBaseMs = Math.round(sessionAudioBaseBytes / (16000 * 2) * 1000);
  const sessionAudioBaseSample = Math.floor(sessionAudioBaseBytes / 2);
  let receivedAudioBytes = 0;
  let pendingAudioChunkMeta = null;
  // P0：端到端可观测状态——首帧 PCM/首帧发送上游/首帧 ASR 结果
  let firstPcmReceived = false;
  let firstPcmSentUpstream = false;
  let firstAsrResult = false;
  let asrNoFirstResultTimer = null;
  let pendingAudioGapReported = false;
  // 端侧 Adapter 可能各自有写入队列，但共享会话不能并发调用 append：
  // 每 256ms 一次的 fire-and-forget 会在 MySQL 端形成未受控的 promise 扇出。
  let sourceAppendChain = Promise.resolve();
  let sourceAppendQueuedBytes = 0;
  // 端侧尚未实现“跨连接滚动窗口恢复”时，必须以标准空状态启动；不能让
  // null/undefined 在首次录音时直接打断 WebSocket 会话。
  // 公司端实现是 async（要查 MySQL asr_window_runs）；await 对公网同步实现同样安全。
  const rollingResumeAudio = (await deps.loadRollingResumeAudio(meetingId, sourceAudioState, sessionAudioBaseMs)) || {
    pcm: Buffer.alloc(0),
    hasPreviousWindow: false,
    startMs: sessionAudioBaseMs,
    commitEndMs: sessionAudioBaseMs,
  };
  rollingAudioChunks = rollingResumeAudio.pcm.length ? [rollingResumeAudio.pcm] : [];
  rollingAudioBytes = rollingResumeAudio.pcm.length;
  rollingWindowHasOverlap = rollingResumeAudio.hasPreviousWindow;
  let rollingAudioStartMs = rollingResumeAudio.startMs;
  // commitCursor 是唯一的“下一段待归属”边界。它只由源音频/VAD 窗口计划推进，
  // 绝不能由文件 ASR 返回的（可能压缩静音的）时间戳推进。
  let rollingCommitCursorMs = rollingResumeAudio.commitEndMs;
  // deps.getLatestTranscriptId 允许是 async（公司端 MySQL）；await 对同步实现同样安全。
  let rollingStartTranscriptId = await deps.getLatestTranscriptId(meetingId);
  // 词库只影响“草稿的确定性规范化”和上游热词。它可能需要 MySQL 查询，但不能
  // 把 SentenceEnd 的草稿落库阻塞几秒。连接建立后异步预热；尚未完成时保留 ASR
  // 原文，45 秒文件稿仍会使用完整词库校正并覆盖该区间。
  let cachedAsrHotwords = [];
  let cachedGlossaryEntries = [];
  void Promise.resolve(typeof deps.getAsrHotwordsForMeeting === "function"
    ? deps.getAsrHotwordsForMeeting(meetingId)
    : [])
    .then((entries) => { cachedAsrHotwords = Array.isArray(entries) ? entries : []; })
    .catch((error) => console.warn(`[asr/live] hotword preload failed meeting=${meetingId}: ${error instanceof Error ? error.message : error}`));
  void Promise.resolve(typeof deps.getMeetingGlossaryEntries === "function"
    ? deps.getMeetingGlossaryEntries(meetingId)
    : [])
    .then((entries) => { cachedGlossaryEntries = Array.isArray(entries) ? entries : []; })
    .catch((error) => console.warn(`[asr/live] glossary preload failed meeting=${meetingId}: ${error instanceof Error ? error.message : error}`));
  connectUpstream();

  function safeSend(payload) {
    if (client.readyState !== WebSocket.OPEN) return;
    try { client.send(JSON.stringify(payload)); } catch { /* client gone */ }
  }

  function withTimeout(promise, timeoutMs, label) {
    const ms = Math.max(1_000, Number(timeoutMs || 0));
    let timer = null;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function enqueueSourceAudio(pcm) {
    if (!Buffer.isBuffer(pcm) || !pcm.length) return Promise.resolve();
    const chunk = Buffer.from(pcm);
    sourceAppendQueuedBytes += chunk.length;
    const task = sourceAppendChain
      .catch(() => undefined)
      .then(() => deps.appendMeetingSourceAudio(meetingId, chunk))
      .finally(() => {
        sourceAppendQueuedBytes = Math.max(0, sourceAppendQueuedBytes - chunk.length);
      });
    sourceAppendChain = task.catch(() => undefined);
    return task;
  }

  function scheduleUpstreamRotation() {
    if (upstreamRotationTimer) clearTimeout(upstreamRotationTimer);
    const delay = Math.max(0, Number(config.ASR_UPSTREAM_ROTATE_AFTER_MS || 0));
    if (!delay) return;
    upstreamRotationTimer = setTimeout(() => {
      upstreamRotationTimer = null;
      if (upstreamStopped || upstream?.readyState !== WebSocket.OPEN || !started) return;
      console.warn(`[asr] proactive rotation meeting=${meetingId} taskId=${upstreamTaskId} ageMs=${delay}`);
      safeSend({ type: "status", status: "upstream_rotating", reason: "planned_task_rotation", delay });
      // 4001 是应用自定义关闭码；close 事件会按普通短退避建立新任务。
      try { upstream.close(4001, "planned_task_rotation"); } catch { /* already closed */ }
    }, delay);
  }

  safeSend({ type: "status", status: "connecting", model });
  safeSend({
    type: "status",
    status: "source_audio_ready",
    sampleRate: 16000,
    nextSample: sessionAudioBaseSample,
    nextAudioMs: sessionAudioBaseMs,
  });
  // P0：确认 source_audio_ready 已送达——日志记录，排查前端未收到的问题
  console.log(`[asr/live] source_audio_ready sent meeting=${meetingId} nextSample=${sessionAudioBaseSample} clientReadyState=${client.readyState}`);

  function getTranscriptTimeLabel() {
    return deps.formatMeetingElapsedTime((sessionAudioBaseBytes + receivedAudioBytes) / (16000 * 2));
  }

  function getTranscriptAudioOffsetMs() {
    // 当前连接的绝对位置 = 连接建立前已持久化样本 + 本连接已收到样本。
    // 不依赖异步 append 的完成时机，也不使用墙上时钟。
    return Math.round((sessionAudioBaseBytes + receivedAudioBytes) / (16000 * 2) * 1000);
  }

  function mapUpstreamAudioTime(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    const mapped = upstreamTaskAudioBaseMs + Math.round(number);
    // 上游可能在重连/排队后返回相对当前已收到音频更“靠后”的时间戳；
    // 不能让它把会议时间轴推进到源音频末尾之后。
    const maxAllowed = getTranscriptAudioOffsetMs() + 1_500;
    if (mapped > maxAllowed) {
      upstreamTimestampClampCount += 1;
      return maxAllowed;
    }
    return mapped;
  }

  function connectUpstream() {
    if (upstreamStopped || client.readyState !== WebSocket.OPEN) return;
    // AIT 直连与公网网关对 WebSocket 握手选项的兼容性不同；公司端沿用已
    // 验证的无附加参数构造方式，公网网关仍可使用显式超时和压缩关闭。
    const current = config.ASR_USE_WS_OPTIONS === false
      ? new WebSocket(upstreamUrl)
      : new WebSocket(upstreamUrl, { handshakeTimeout: 5000, perMessageDeflate: false });
    // WS 心跳：每 20s 发 ping，超时 20s 未 pong 则认为连接死掉
    current.on("ping", () => { try { current.pong(); } catch { /* gone */ } });
    current._pingTimer = setInterval(() => {
      if (current.readyState === WebSocket.OPEN) {
        try { current.ping(); } catch { /* gone */ }
      }
    }, 20000);
    upstream = current;
    upstreamOpen = false;
    started = false;
    upstreamTaskId = randomUUID();

    current.on("open", async () => {
      if (current !== upstream || upstreamStopped) return;
      upstreamOpen = true;
      // 词库已在会话初始化时异步预热。上游 StartTranscription 不等待数据库，避免
      // 公司端 MySQL 慢查询直接放大为“开始录音后几秒没有实时转写”。
      const hotwordText = cachedAsrHotwords.join(",");

      const payload = {
        format: "pcm",
        sample_rate: 16000,
        enable_intermediate_result: true,
        enable_punctuation_prediction: true,
        enable_inverse_text_normalization: true,
      };
      // 某些 AIT 直连流式模型只接受基础字段；扩展字段由端侧显式开启，避免
      // 服务器因参数不认识而在 StartTranscription 后立即关闭连接。
      if (config.ASR_ENABLE_ADVANCED_PAYLOAD !== false) {
        payload.disfluency = true;
        payload.max_sentence_silence = config.ASR_UPSTREAM_MAX_SENTENCE_SILENCE;
        payload.enable_semantic_sentence_detection = true;
      }
      // 传 hotword 参数给 ASR（FunASR/Bella 支持；AIT 直连基础模型不支持，会导致
      // StartTranscription 后立即断开，与 ASR_ENABLE_ADVANCED_PAYLOAD 一起控制）
      if (config.ASR_ENABLE_ADVANCED_PAYLOAD !== false && hotwordText) {
        payload.hotword = hotwordText;
      }
      current.send(JSON.stringify({
        header: {
          message_id: randomUUID(),
          task_id: upstreamTaskId,
          namespace: "SpeechTranscriber",
          name: "StartTranscription",
          appkey: "default",
        },
        payload,
      }));
      safeSend({ type: "status", status: upstreamReconnectAttempt ? "reconnected" : "connected", model });
    });

    current.on("message", (data, isBinary) => {
      if (current !== upstream || isBinary) return;
      const raw = String(data);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        safeSend({ type: "raw", data: raw });
        return;
      }

      const name = message?.header?.name;
      const result = message?.payload?.result || "";

      if (name === "TranscriptionStarted") {
        started = true;
        // AIT 的句子时间戳相对于当前 upstream task 起点。重连时扣除尚未
        // 发送的 pending 音频，得到连续的会议绝对时间轴。
        upstreamTaskAudioBaseMs = Math.max(
          sessionAudioBaseMs,
          getTranscriptAudioOffsetMs() - Math.round(pendingAudioBytes / (16000 * 2) * 1000),
        );
        upstreamReconnectAttempt = 0;
        asrNoFirstResultReconnectAttempt = 0;
        // P0：受控重连后新上游任务——重置 first_asr_result 检测，让新任务的 12 秒窗口重新计时
        firstAsrResult = false;
        if (asrNoFirstResultTimer) clearTimeout(asrNoFirstResultTimer);
        asrNoFirstResultTimer = null;
        while (pendingAudioChunks.length) {
          const chunk = pendingAudioChunks.shift();
          if (current.readyState === WebSocket.OPEN) current.send(chunk, { binary: true });
        }
        pendingAudioBytes = 0;
        pendingAudioGapReported = false;
        // 静音保活：每 10s 检查一次，如果距上次发音频超过 10s，补发静音帧
        if (silenceKeepaliveTimer) clearInterval(silenceKeepaliveTimer);
        silenceKeepaliveTimer = setInterval(() => {
          if (current !== upstream || current.readyState !== WebSocket.OPEN || !started) return;
          if (Date.now() - lastAudioSentAt < 10000) return;
          const silenceFrame = Buffer.alloc(3200); // 100ms 静音 PCM @16k/16bit
          try { current.send(silenceFrame, { binary: true }); } catch { /* gone */ }
        }, 10000);
        scheduleUpstreamRotation();
        safeSend({ type: "status", status: "started", model });
        return;
      }

      if (name === "TranscriptionResultChanged" && result) {
        latestPartial = result;
        // P0：端到端可观测状态——首帧 ASR 结果
        if (!firstAsrResult) {
          firstAsrResult = true;
          asrNoFirstResultReconnectAttempt = 0;
          if (asrNoFirstResultTimer) { clearTimeout(asrNoFirstResultTimer); asrNoFirstResultTimer = null; }
          safeSend({ type: "status", status: "first_asr_result", kind: "partial" });
        }
        safeSend({ type: "transcript.partial", text: result });
        // 不能把是否收到浏览器 VAD 端点作为落稿前提。部分 LM 模型只发
        // 累积 partial，不发 SentenceEnd；服务端独立兜底，保证长句中间也
        // 会出现 draft 行，稳定稿随后按时间区间替换它。
        schedulePartialProgressFlush();
        return;
      }

      if (name === "SentenceEnd" && result) {
        // SentenceEnd 可能把此前已按 partial-progress 落过的整句再次返回。
        // 只提交尚未落轴的尾部；若没有尾部则不再插入完整重复句。
        const normalizedSentence = deps.normalizeTranscriptSegment(result);
        const uncommittedSentence = deps.normalizeTranscriptSegment(
          getUncommittedCumulativeText(partialProgressCommittedText, normalizedSentence),
        );
        const committedAudioEndMs = partialProgressLastAudioEndMs;
        resetPartialProgressState();
        // P0：端到端可观测状态——首帧 ASR 结果
        if (!firstAsrResult) {
          firstAsrResult = true;
          asrNoFirstResultReconnectAttempt = 0;
          if (asrNoFirstResultTimer) { clearTimeout(asrNoFirstResultTimer); asrNoFirstResultTimer = null; }
          safeSend({ type: "status", status: "first_asr_result", kind: "final" });
        }
        const payload = message?.payload || {};
        const mappedStartMs = mapUpstreamAudioTime(payload.begin_time ?? payload.beginTime ?? payload.start_time ?? payload.startTime);
        const mappedEndMs = mapUpstreamAudioTime(payload.end_time ?? payload.endTime ?? payload.time);
        if (uncommittedSentence) {
          pushTranscriptSegment(uncommittedSentence, {
            startMs: committedAudioEndMs > 0 ? Math.max(mappedStartMs, committedAudioEndMs) : mappedStartMs,
            endMs: mappedEndMs,
          });
        }
        // SentenceEnd 是上游已确认的句界，不能再把草稿是否落库交给浏览器
        // VAD 的 endpoint 事件决定。浏览器端点事件丢失、延迟或连续说话时，
        // 这里仍必须在短延迟后冻结这一段并写入时间轴；45 秒稳定稿会再原位替换。
        scheduleTranscriptFlush("sentence_end");
        return;
      }

      if (name === "TranscriptionFailed" || name === "TASK_FAILED") {
        const messageText = message?.header?.status_message || "ASR failed";
        console.error(`[asr] upstream task failed meeting=${meetingId}: ${messageText}`);
        safeSend({ type: "status", status: "upstream_reconnecting", reason: messageText });
        // 由 close 事件统一安排重连。此前这里先 schedule、close 回调又 schedule，
        // 新连接可能在旧任务尚未释放前建立，从而触发 AIT 1009 并发限制。
        if (current.readyState === WebSocket.OPEN) current.close(3000, "task failed");
        else scheduleUpstreamReconnect(messageText);
        return;
      }

      safeSend({ type: "event", name, payload: message?.payload || {} });
    });

    current.on("close", (code, reason) => {
      if (current !== upstream || upstreamStopped) return;
      upstreamOpen = false;
      started = false;
      if (upstreamRotationTimer) { clearTimeout(upstreamRotationTimer); upstreamRotationTimer = null; }
      if (current._pingTimer) { clearInterval(current._pingTimer); current._pingTimer = null; }
      if (silenceKeepaliveTimer) { clearInterval(silenceKeepaliveTimer); silenceKeepaliveTimer = null; }
      const reasonText = reason.toString();
      console.error(`[asr] upstream closed meeting=${meetingId} code=${code} reason=${reasonText || "none"}`);
      void flushTranscriptBuffer("upstream_close", { fallbackToPartial: true });
      resetPartialProgressState();
      scheduleUpstreamReconnect(reasonText || `code ${code}`);
    });

    current.on("error", (error) => {
      if (current !== upstream || upstreamStopped) return;
      console.error(`[asr] upstream error meeting=${meetingId}: `, error);
      safeSend({ type: "status", status: "upstream_reconnecting", reason: error.message });
    });
  }

  function scheduleUpstreamReconnect(reason = "upstream closed") {
    if (upstreamStopped || client.readyState !== WebSocket.OPEN) return;
    if (upstreamReconnectTimer) clearTimeout(upstreamReconnectTimer);
    upstreamReconnectAttempt += 1;
    const plan = getUpstreamReconnectPlan(reason, upstreamReconnectAttempt, config);
    const { delay, isConcurrencyLimit, isPlannedRotation } = plan;
    safeSend({
      type: "status",
      status: "upstream_reconnecting",
      reason,
      attempt: upstreamReconnectAttempt,
      delay,
      recoveryMode: isConcurrencyLimit ? "concurrency_cooldown" : (isPlannedRotation ? "rotation_cooldown" : "reconnect"),
      stableTranscriptContinues: Boolean(isConcurrencyLimit || isPlannedRotation),
    });
    upstreamReconnectTimer = setTimeout(() => {
      upstreamReconnectTimer = null;
      connectUpstream();
    }, delay);
  }

  const processClientMessage = async (data, isBinary) => {
    if (!isBinary) {
      const text = String(data);
      let control = null;
      try {
        control = JSON.parse(text);
      } catch {
        control = null;
      }
      if (control?.type === "audio.chunk") {
        pendingAudioChunkMeta = {
          sequence: Number(control.sequence),
          startSample: Number(control.startSample),
          sampleCount: Number(control.sampleCount),
          sampleRate: Number(control.sampleRate || 16000),
        };
        return;
      }
      if (control?.type === "vad.speech_start") {
        if (!activeRollingSpeech) activeRollingSpeech = { startMs: getTranscriptAudioOffsetMs(), endMs: null };
        if (transcriptFlushTimer && transcriptFlushReason !== "sentence_end") {
          clearTimeout(transcriptFlushTimer);
          transcriptFlushTimer = null;
          transcriptFlushReason = "";
          safeSend({ type: "status", status: "merge_pending_speech" });
        }
        if (!transcriptBuffer) {
          pendingSpeechStartAt = getTranscriptTimeLabel();
          pendingSpeechStartAudioMs = getTranscriptAudioOffsetMs();
          transcriptBufferStartedAt = pendingSpeechStartAt;
          transcriptBufferStartedAudioMs = pendingSpeechStartAudioMs;
          transcriptBufferEndAudioMs = 0;
          speechAudioChunks = [];
          speechAudioBytes = 0;
        }
        client.send(JSON.stringify({ type: "status", status: "speech_start" }));
        return;
      }
      if (control?.type === "vad.endpoint") {
        clearPartialProgressTimer();
        if (activeRollingSpeech) {
          activeRollingSpeech.endMs = getTranscriptAudioOffsetMs();
          rollingSpeechIntervals.push(activeRollingSpeech);
          // 校准停滞时区间只增不滤，保留最近 500 段防内存膨胀。
          if (rollingSpeechIntervals.length > 500) rollingSpeechIntervals.splice(0, rollingSpeechIntervals.length - 500);
          activeRollingSpeech = null;
        }
        scheduleTranscriptFlush(control.reason || "endpoint", { fallbackToPartial: true });
        // 浏览器 VAD 的短暂停顿不等于上游 LM 已经切句。上游仍可能继续返回
        // 从原句首开始的累计 partial，因此这里必须保留累计游标；真正收到
        // SentenceEnd 或上游重启时才重置。
        return;
      }
      if (text === "stop") {
        stopRequested = true;
        if (transcriptFlushTimer) {
          clearTimeout(transcriptFlushTimer);
          transcriptFlushTimer = null;
          transcriptFlushReason = "";
        }
        await sealMeeting("stop");
        stopUpstream();
      }
      return;
    }
    let chunk = Buffer.from(data);
    const chunkMeta = pendingAudioChunkMeta;
    pendingAudioChunkMeta = null;
    const expectedStartSample = sessionAudioBaseSample + Math.floor(receivedAudioBytes / 2);
    if (chunkMeta) {
      const actualSampleCount = Math.floor(chunk.length / 2);
      if (
        chunkMeta.sampleRate !== 16000
        || !Number.isFinite(chunkMeta.startSample)
        || !Number.isFinite(chunkMeta.sampleCount)
        || chunkMeta.sampleCount !== actualSampleCount
      ) {
        safeSend({
          type: "status",
          status: "source_audio_chunk_rejected",
          reason: "invalid_chunk_metadata",
          expectedSample: expectedStartSample,
          sequence: chunkMeta.sequence,
        });
        return;
      }
      if (chunkMeta.startSample < expectedStartSample) {
        const duplicateSamples = expectedStartSample - chunkMeta.startSample;
        if (duplicateSamples >= actualSampleCount) {
          safeSend({
            type: "status",
            status: "source_audio_committed",
            nextSample: expectedStartSample,
            duplicate: true,
            sequence: chunkMeta.sequence,
          });
          return;
        }
        chunk = chunk.subarray(duplicateSamples * 2);
      } else if (chunkMeta.startSample > expectedStartSample) {
        // 丢帧/首帧竞态导致的错位不能永久拒绝整段录音：记录并向前对齐，
        // 缺口由 rolling 文件 ASR 从源音频补齐（源音频同位置也会缺，语义一致）。
        console.error(`[source-audio] gap resync meeting=${meetingId} expected=${expectedStartSample} received=${chunkMeta.startSample}`);
        safeSend({
          type: "status",
          status: "source_audio_gap_resync",
          expectedSample: expectedStartSample,
          receivedSample: chunkMeta.startSample,
        });
        const gapBytes = Math.max(0, (chunkMeta.startSample - expectedStartSample) * 2);
        if (gapBytes > 0 && gapBytes <= 16000 * 2 * 600) {
          // 源音频按样本序号定位，缺口必须填等量静音，否则后续时间轴整体漂移。
          void enqueueSourceAudio(Buffer.alloc(gapBytes)).catch(() => {});
        }
        receivedAudioBytes = Math.max(0, (chunkMeta.startSample - sessionAudioBaseSample) * 2);
      }
    }
    const acceptedSequence = chunkMeta?.sequence;
    const acceptedEndSample = expectedStartSample + Math.floor(chunk.length / 2);
    void enqueueSourceAudio(chunk).then(() => {
      safeSend({
        type: "status",
        status: "source_audio_committed",
        sampleRate: 16000,
        nextSample: acceptedEndSample,
        sequence: acceptedSequence,
      });
    }).catch((error) => {
      console.error(`[source-audio] append failed meeting=${meetingId}: `, error);
      safeSend({ type: "status", status: "source_audio_error", message: "完整录音保存异常" });
    });
    receivedAudioBytes += chunk.length;
    // P0：端到端可观测状态——首帧 PCM 已收到
    if (!firstPcmReceived) {
      firstPcmReceived = true;
      safeSend({ type: "status", status: "first_pcm_received", bytes: chunk.length, sampleCount: chunk.length / 2 });
    }
    if (deps.config.ROLLING_ASR_ENABLED) {
      if (!rollingAudioBytes) {
        rollingAudioStartMs = Math.round((sessionAudioBaseBytes + receivedAudioBytes - chunk.length) / (16000 * 2) * 1000);
      }
      rollingAudioChunks.push(chunk);
      rollingAudioBytes += chunk.length;
      if (getRollingWindowPlan(false) && !rollingRetryRunning) {
        if (rollingCorrectionRunning) rollingCorrectionQueued = true;
        else void triggerRollingCorrection(false);
      }
    }
    if (speechAudioBytes < 2_000_000) {
      speechAudioChunks.push(chunk);
      speechAudioBytes += chunk.length;
    }
    // P0：真实语音 PCM 字节数（自适应 VAD）——asr_no_first_result 定时器只在有真实语音时启动
    if (isRealSpeechPcm(chunk)) {
      realSpeechAudioBytes += chunk.length;
    }
    if (upstreamOpen && started && upstream?.readyState === WebSocket.OPEN) {
      upstream.send(chunk, { binary: true });
      lastAudioSentAt = Date.now();
      // P0：端到端可观测状态——首帧 PCM 已发送上游
      if (!firstPcmSentUpstream) {
        firstPcmSentUpstream = true;
        safeSend({ type: "status", status: "first_pcm_sent_upstream", bytes: chunk.length });
      }
      // P0：asr_no_first_result 定时器只在真实语音 PCM 时启动——静音保活帧不应触发上游健康检查
      if (realSpeechAudioBytes > 0 && !asrNoFirstResultTimer && !firstAsrResult) {
        asrNoFirstResultTimer = setTimeout(() => {
          if (firstAsrResult) return;
          // 重连前必须确认有非静音音频已发送——静音保活帧不算有效语音
          if (realSpeechAudioBytes === 0) return;
          // P0：记录结构化日志（模型、任务 ID、发送字节数、最后上游事件），按 meetingId 可查
          console.error(
            `[asr] no_first_result meeting=${meetingId} model=${model} taskId=${upstreamTaskId || "none"} sentBytes=${receivedAudioBytes} realSpeechBytes=${realSpeechAudioBytes} attempt=${asrNoFirstResultReconnectAttempt + 1}/${ASR_NO_FIRST_RESULT_MAX_RECONNECT}`
          );
          safeSend({ type: "status", status: "asr_no_first_result", model, taskId: upstreamTaskId, sentBytes: receivedAudioBytes });
          if (asrNoFirstResultReconnectAttempt >= ASR_NO_FIRST_RESULT_MAX_RECONNECT) {
            // 达到重试上限——向用户展示错误，不无限停留在"识别中"
            safeSend({
              type: "status",
              status: "asr_failed",
              message: "识别服务持续无响应，请结束录音后重试",
              model,
              taskId: upstreamTaskId,
              sentBytes: receivedAudioBytes,
            });
            return;
          }
          asrNoFirstResultReconnectAttempt += 1;
          // 关闭该上游任务；由 close 事件统一安排受控重连。若这里立刻 schedule，
          // 会和 close 回调重复安排，可能在旧任务未释放时抢占 AIT 并发名额。
          if (upstream?.readyState === WebSocket.OPEN) {
            try { upstream.close(4000, "no_first_result"); } catch { /* ignore */ }
          } else {
            scheduleUpstreamReconnect("asr_no_first_result");
          }
        }, 12_000);
      }
      return;
    }
    if (pendingAudioBytes + chunk.length <= config.ASR_PENDING_AUDIO_MAX_BYTES) {
      pendingAudioChunks.push(chunk);
      pendingAudioBytes += chunk.length;
    } else if (!pendingAudioGapReported) {
      pendingAudioGapReported = true;
      safeSend({
        type: "status",
        status: "realtime_asr_audio_gap",
        message: "实时 ASR 中断时间过长，完整录音仍已保存，将由文件 ASR 补齐",
      });
    }
  };
  // 先回放 init 期间的缓冲帧，再放行实时帧；回放期间新到的帧继续入队，最后统一处理。
  client.on("message", (data, isBinary) => { void processClientMessage(data, isBinary); });
  for (const [data, isBinary] of preInitFrames.splice(0)) await processClientMessage(data, isBinary);
  replayDone = true;
  while (preInitFrames.length) {
    const [data, isBinary] = preInitFrames.shift();
    void processClientMessage(data, isBinary);
  }

  client.on("close", () => {
    clearInterval(clientPingTimer);
    clearInterval(audioOffsetTimer);
    resetPartialProgressState();
    // 清理连接锁，允许后续重连
    if (meetingLiveConnections.get(meetingId) === client) meetingLiveConnections.delete(meetingId);
    if (transcriptFlushTimer) {
      clearTimeout(transcriptFlushTimer);
      transcriptFlushTimer = null;
      transcriptFlushReason = "";
    }
    if (!stopRequested) void pauseMeetingOnDisconnect();
    stopUpstream();
  });

  async function pauseMeetingOnDisconnect() {
    try {
      await flushTranscriptBuffer("client_close", { fallbackToPartial: true });
      const sourceBytes = sessionAudioBaseBytes + receivedAudioBytes;
      void Promise.resolve(deps.persistMeetingElapsedSeconds(meetingId, sourceBytes / (16000 * 2))).catch(() => {});
      await deps.checkpointMeetingSourceAudio(meetingId, "partial");
    } catch (error) {
      console.error(`[pause] checkpoint failed meeting=${meetingId}: `, error);
    }
  }

  function sealMeeting(reason) {
    if (sealingPromise) return sealingPromise;
    // 会议结束通常会和 rolling 校准、源音频追加写入同时落库。SQLite 在短暂
    // 写锁竞争时不应把整个 Node 进程带崩；耗时字段只是辅助展示，失败可由
    // 后续稳定化/下一次状态写入补齐。
    try {
      const sourceBytes = sessionAudioBaseBytes + receivedAudioBytes;
      void Promise.resolve(deps.persistMeetingElapsedSeconds(meetingId, sourceBytes / (16000 * 2))).catch(() => {});
    } catch (error) {
      console.error(`[seal] persist elapsed failed meeting=${meetingId}: `, error);
    }
    deps.beginMeetingAiJob(meetingId);
    sealingPromise = (async () => {
      // P0.3：从用户点击结束开始设置唯一绝对 deadline（60-75 秒）。
      // 滚动文件 ASR、轮询、LLM 对齐、重试均接受 AbortSignal。
      const tailDeadlineMs = 70_000; // 70 秒绝对截止时间
      const tailDeadline = Date.now() + tailDeadlineMs;
      const tailAbortController = new AbortController();
      const tailAbortSignal = tailAbortController.signal;
      sealingAbortSignal = tailAbortSignal;
      // deadline 到达后立即取消本轮未完成任务
      const tailDeadlineTimer = setTimeout(() => {
        console.error(`[seal] tail deadline reached meeting=${meetingId}，取消本轮未完成任务`);
        tailAbortController.abort();
      }, tailDeadlineMs);

      await flushTranscriptBuffer(reason, { fallbackToPartial: true });
      // 在真正开始尾段文件 ASR 前先持久化中间状态。这样即使 WebSocket、Pod
      // 或上游请求在中途失联，服务端门禁也能识别为“待收口”并走超时兜底；
      // 不能一直停留在 recording，导致当前这场会议没有可恢复的状态。
      try {
        await deps.markMeetingSourceAudioStabilizing?.(meetingId);
      } catch (error) {
        console.error(`[seal] mark tail stabilizing failed meeting=${meetingId}: `, error);
      }
      // 会中失败窗口可以后台退避重试；用户已点击结束后绝不能继续无界重试，
      // 否则一次文件 ASR 卡住会永久占住归档。尾段本轮限时执行，失败即走实时稿收口。
      // 这里必须对“整个尾段 drain”限时，而不只是单个文件 ASR 请求限时。
      // triggerRollingCorrection 会在 finally 中继续处理下一扇窗口；若某一扇
      // 音频/上游调用一直不返回，之前的单窗 timeout 不能保证 sealMeeting 返回，
      // 前端便会永久停在“尾段校准中”。超时后保留已经产出的稳定稿，并由下方
      // forced-stable 兜底收口，完整源录音仍保留，后续可再次校准。
      // P0.3：triggerRollingCorrection 接受 AbortSignal（deadline 到达后立即取消）。
      let tailDrainCompleted = true;
      try {
        // 结束恰好落在会中滚动窗口执行期间时，triggerRollingCorrection(true)
        // 只会设置 rollingFinalRequested 后立即返回。若这里把这个“已请求”
        // 误当成“已完成”，下方 forced-stable 会先把尾部 draft 转为稳定稿，
        // 随后真正的尾窗文件稿又插入同一段时间，形成重复文本和时间轴重叠。
        // 必须在全局 deadline 内排空正在执行的窗口及其递归尾窗，确认没有可提交
        // 的中心区间后，才能决定是否使用实时稿兜底。
        // 外层等待与每个尾窗请求都必须共用同一个绝对 deadline。不能再额外
        // 叠加一个更短的配置超时，否则文件 ASR 已在正常返回、但尚未到 70 秒
        // 总上限时就被 forced-stable 抢先覆盖，造成尾段永久残留实时草稿。
        const tailDrainBudgetMs = Math.max(1, tailDeadline - Date.now());
        tailDrainCompleted = await withTimeout(
          drainFinalRollingCorrections(tailAbortSignal, tailDeadline),
          tailDrainBudgetMs,
          "tail_stabilization_total",
        );
      } catch (error) {
        tailDrainCompleted = false;
        console.error(`[seal] tail stabilization timed out meeting=${meetingId}: `, error);
      }
      const retriesResolved = tailDrainCompleted && failedRollingWindows.length === 0;
      // P0.3：deadline 到达后不再额外无条件等待 120 秒——立即取消本轮未完成任务。
      if (rollingCorrectionRunning || rollingRetryRunning) {
        if (Date.now() >= tailDeadline) {
          console.error(`[seal] tail deadline reached meeting=${meetingId}，跳过 waitForMeetingAiJobs（立即收口）`);
        } else {
          // sealMeeting 自身就是一个进行中的任务。这里只等待并行的滚动校准/重试，
          // 不能把自身也算进“待完成任务”，否则必定等到 120 秒超时。
          const remainingMs = Math.max(0, tailDeadline - Date.now());
          await deps.waitForMeetingAiJobs(meetingId, Math.min(remainingMs, 10_000), 1);
        }
      }
      clearTimeout(tailDeadlineTimer);
      // 用户明确点击结束时，当前 WebSocket 仍在连接表中是正常状态；此时必须
      // 强制把已写完的完整源录音封存，不能被“仍有连接”误判回 recording。
      await deps.finalizeMeetingSourceAudio(
        meetingId,
        reason === "stop" ? "complete" : "partial",
        { force: reason === "stop" },
      );
      // 完整录音封存后再做一次会议级说话人校准。它不影响文字稳定化，但
      // 最终纪要必须使用这次校准后的说话人轨道，而不是窗口临时标签。
      try {
        const speakerResult = await withTimeout(
          deps.reconcileMeetingSpeakersFromSourceAudio(meetingId),
          config.POST_MEETING_SPEAKER_TIMEOUT_MS,
          "post_meeting_speaker",
        );
        if (!speakerResult.ok) console.warn(`[post-meeting-speaker] skipped meeting=${meetingId}: ${speakerResult.reason || speakerResult.message || "unknown"}`);
      } catch (error) {
        console.error(`[post-meeting-speaker] failed meeting=${meetingId}: `, error);
      }
      const draftCount = await countDraftTranscripts(meetingId);
      const hasPendingRollingRetry = failedRollingWindows.some((window) => Number(window.attempt || 0) < deps.config.ROLLING_ASR_MAX_RETRIES);
      // 文件校准可能因边界/低置信度而没有可重试窗口，但仍留下少量 draft。
      // 此时不能永久停在 sealed_pending_correction；在所有校准任务已收口后，
      // 按既定兜底策略把残留稿标记为 forced stable，保证会议可归档可回放。
      if (draftCount > 0 && !hasPendingRollingRetry && !rollingCorrectionRunning && !rollingRetryRunning) {
        const forced = await forceStabilizeDraftTranscripts(meetingId);
        if (forced > 0) {
          safeSend({
            type: "status",
            status: "sealed",
            forcedStableCount: forced,
            // fallbackCount 是既有前端消费字段；保留它避免已经完成收口却
            // 被前端误显示为“仍在尾段校准”。
            fallbackCount: forced,
            message: `已强制收口 ${forced} 条未校准转写`,
          });
          return;
        }
      }
      if (!retriesResolved || draftCount > 0) {
        // 用户明确结束会议后，不能让失败的尾段重试永久占住归档入口。
        // 文件 ASR 的后台重试只适合会中窗口；会后立即以现有实时稿收口，
        // 同时保留完整录音供回听和后续修复，最终纪要永远有可用输入。
        const forced = await forceStabilizeDraftTranscripts(meetingId);
        // 结构化尾段降级状态：尾段文件 ASR 超时必须在限定时间后自动进入"草稿可归档"状态，
        // 不能永久卡住。失败原因和重试次数在服务端可查询。
        const tailFailureCode = retriesResolved ? "tail_asr_timeout" : "tail_asr_retry_exhausted";
        const tailFailureReason = retriesResolved
          ? "尾段文件 ASR 超时，已用实时稿收口"
          : `尾段文件 ASR 重试 ${failedRollingWindows.length} 次仍失败，已用实时稿收口`;
        safeSend({
          type: "status",
          status: "sealed",
          forcedStableCount: forced,
          fallbackCount: forced,
          tailFailureCode,
          tailFailureReason,
          tailFailedWindows: failedRollingWindows.length,
          message: forced > 0
            ? `尾段文件校准未完成，已用 ${forced} 条实时稿收口`
            : "尾段文件校准未完成，已保留现有稳定稿并收口",
        });
        return;
      }
      safeSend({ type: "status", status: "sealed" });
    })().finally(() => {
      sealingAbortSignal = null;
      deps.endMeetingAiJob(meetingId);
    });
    return sealingPromise;
  }

  async function countDraftTranscripts(meetingIdParam) {
    // 公司端用 MySQL（deps.countDraftTranscripts），公网端也应该实现 deps.countDraftTranscripts（SQLite）。
    if (typeof deps.countDraftTranscripts === "function") {
      return Number(await deps.countDraftTranscripts(meetingIdParam)) || 0;
    }
    console.error(`[seal] count drafts failed meeting=${meetingIdParam}: no countDraftTranscripts`);
    return Number.MAX_SAFE_INTEGER;
  }

  async function forceStabilizeDraftTranscripts(meetingIdParam) {
    if (typeof deps.forceStabilizeDraftTranscripts === "function") {
      return Number(await deps.forceStabilizeDraftTranscripts(meetingIdParam)) || 0;
    }
    // 公司端用 MySQL（deps.forceStabilizeDraftTranscripts），公网端也应该实现 deps.forceStabilizeDraftTranscripts（SQLite）。
    console.error(`[seal] force stabilize failed meeting=${meetingIdParam}: no forceStabilizeDraftTranscripts`);
    return 0;
  }

  async function drainFinalRollingCorrections(abortSignal, deadlineMs) {
    const deadline = Math.max(Date.now(), Number(deadlineMs || Date.now()));
    while (!abortSignal?.aborted && Date.now() < deadline) {
      // 既有会中窗口可能在用户点击结束前已经开始。它的 finally 会依据
      // rollingFinalRequested 递归处理尾窗；这里等待整个链条，而不是只等
      // 第一个 trigger 调用返回。
      if (rollingCorrectionRunning || rollingRetryRunning) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      // 没有正在执行的窗口时，由尾段主动继续清空剩余的源音频。plan 为空
      // 才表示已没有尚未归属的中心区间；不能只因为某一次请求返回 null 就
      // 提前把草稿强制升级为稳定稿。
      if (!getRollingWindowPlan(true)) return true;
      await triggerRollingCorrection(true, abortSignal);
    }
    return false;
  }

  function getRollingWindowPlan(isFinal) {
    const msPerByte = 1000 / (16000 * 2);
    const requestStartMs = Math.max(0, Number(rollingAudioStartMs || 0));
    const availableEndMs = requestStartMs + rollingAudioBytes * msPerByte;
    const speechIntervals = deps.normalizeSpeechIntervals([
      ...rollingSpeechIntervals,
      // 仍在说话的区间不能伪装成“当前已结束”：否则 commitEnd 会随着音频
      // 到达不断后移，永远等不到右侧 8 秒上下文。长发言交给 30 秒硬上限。
      ...(activeRollingSpeech ? [activeRollingSpeech] : []),
    ]);
    const planned = deps.buildRollingWindowPlan({
      requestStartMs,
      availableEndMs,
      commitStartMs: Math.max(requestStartMs, Number(rollingCommitCursorMs || requestStartMs)),
      isFinal,
      windowMs: deps.config.ROLLING_ASR_WINDOW_SECONDS * 1000,
      baseLookbackMs: deps.config.ROLLING_ASR_OVERLAP_SECONDS * 1000,
      maxLookbackMs: deps.config.ROLLING_ASR_MAX_LOOKBACK_SECONDS * 1000,
      rightContextMs: deps.config.ROLLING_ASR_OVERLAP_SECONDS * 1000,
      maxForwardExtensionMs: deps.config.ROLLING_ASR_MAX_BOUNDARY_EXTENSION_SECONDS * 1000,
      speechIntervals,
    });
    if (!planned) return null;
    const requestEndMs = planned.requestEndMs;
    const requestBytes = Math.min(
      rollingAudioBytes,
      Math.max(0, Math.round((requestEndMs - requestStartMs) * 16000 * 2 / 1000)),
    );
    return {
      ...planned,
      requestEndMs: requestStartMs + requestBytes * msPerByte,
      requestBytes,
      centerStartMs: planned.commitStartMs,
      centerEndMs: planned.commitEndMs,
      speechIntervals,
    };
  }

  async function triggerRollingCorrection(isFinal, abortSignal = null, attempt = 0) {
    if (!deps.config.ROLLING_ASR_ENABLED) return null;
    // P0.3：deadline 到达后立即取消（AbortSignal）
    if (abortSignal?.aborted) {
      console.log(`[rolling-asr] aborted before start meeting=${meetingId}`);
      return null;
    }
    if (rollingCorrectionRunning || rollingRetryRunning) {
      if (isFinal) rollingFinalRequested = true;
      if (!isFinal) rollingCorrectionQueued = true;
      return null;
    }
    // 校准期间实时音频仍会继续到达。每次只取一个完整窗口，余量留在
    // 缓冲中逐窗处理；否则慢一次校准就会把数分钟音频拼成一个请求。
    const plan = getRollingWindowPlan(isFinal);
    if (!plan) return null;
    const bufferedPcm = Buffer.concat(rollingAudioChunks);
    const pcm = bufferedPcm.subarray(0, Math.min(bufferedPcm.length, plan.requestBytes));
    const durationSeconds = pcm.length / (16000 * 2);
    if (durationSeconds < (isFinal ? 0.5 : deps.config.ROLLING_ASR_MIN_SECONDS)) return null;
    rollingCorrectionRunning = true;
    deps.beginMeetingAiJob(meetingId);
    // 在任何 await 前把本次窗口从共享缓冲摘除。否则等待实时稿 flush 时
    // 新到的音频会先追加进数组，随后又被旧快照覆盖，造成音频静默丢失。
    const initialRemainder = bufferedPcm.subarray(pcm.length);
    rollingAudioChunks = initialRemainder.length ? [initialRemainder] : [];
    rollingAudioBytes = initialRemainder.length;
    let correctionSucceeded = false;
    let retryFinal = false;
    let correctionStartId = 0;
    let correctionEndId = 0;
    let correctionTrimLeadingSeconds = plan.trimLeadingSeconds;
    let correctionTrimTrailingSeconds = plan.trimTrailingSeconds;
    const windowStartAudioMs = plan.requestStartMs;
    const windowDurationMs = Math.round(durationSeconds * 1000);
    const windowEndAudioMs = windowStartAudioMs + windowDurationMs;
    const rollingCommitCursorBeforeCorrection = rollingCommitCursorMs;
    try {
      if (!isFinal) await flushTranscriptBuffer("rolling_window", { fallbackToPartial: true });
      const currentEndTranscriptId = await deps.getLatestTranscriptId(meetingId);
      correctionStartId = rollingStartTranscriptId;
      correctionEndId = currentEndTranscriptId;
      // 本次窗口已经同步移走；处理期间新来的音频只会追加到当前缓冲，
      // 成功后再把 overlap 放回队首，形成下一个精确窗口。
      const submittedDurationSeconds = Number((pcm.length / (16000 * 2)).toFixed(1));
      console.log(`[rolling-asr] submitting meeting=${meetingId} duration=${submittedDurationSeconds}s start=${correctionStartId} end=${correctionEndId}`);
      safeSend({ type: "status", status: "rolling_correction", model: deps.config.ROLLING_ASR_MODEL, submittedDurationSeconds });
      // P0.3：performRollingTranscriptCorrection 接受 AbortSignal（deadline 到达后立即取消）
      const correctionPromise = deps.performRollingTranscriptCorrection({
        meetingId,
        pcm,
        startTranscriptId: correctionStartId,
        endTranscriptId: correctionEndId,
        model: deps.config.ROLLING_ASR_MODEL,
        trimLeadingSeconds: correctionTrimLeadingSeconds,
        trimTrailingSeconds: correctionTrimTrailingSeconds,
        windowStartAudioMs,
        windowEndAudioMs,
        centerStartAudioMs: plan.centerStartMs,
        centerEndAudioMs: plan.centerEndMs,
        sourceSpeechIntervals: plan.speechIntervals,
        forcedBoundary: plan.forcedBoundary,
        allowBoundaryRows: Boolean(isFinal),
        abortSignal,
      });
      const result = await withTimeout(
        correctionPromise,
        isFinal ? config.TAIL_STABILIZATION_TIMEOUT_MS : config.ROLLING_ASR_TIMEOUT_MS,
        isFinal ? "tail_stabilization" : "rolling_correction",
      );
      rollingStartTranscriptId = Math.max(rollingStartTranscriptId, Number(result.lastProcessedTranscriptId || correctionStartId));
      rollingWindowHasOverlap = true;
      const pendingAudio = Buffer.concat(rollingAudioChunks);
      const commitEndAudioMs = plan.commitEndMs;
      // 长发言没有句子边界时，findRollingContextStart 会回落到 0，
      // 必须钳制在 commitEnd - maxLookback 以内，否则窗口每次都从 0 重新
      // 提交、越来越大，直到文件 ASR 超时失败（生产"2 分钟后校准必失败"根因）。
      const contextFloorMs = Math.max(0, commitEndAudioMs - deps.config.ROLLING_ASR_MAX_LOOKBACK_SECONDS * 1000);
      const nextRequestStartMs = Math.max(windowStartAudioMs, contextFloorMs, deps.findRollingContextStart({
        commitStartMs: commitEndAudioMs,
        speechIntervals: plan.speechIntervals,
        baseLookbackMs: deps.config.ROLLING_ASR_OVERLAP_SECONDS * 1000,
        maxLookbackMs: deps.config.ROLLING_ASR_MAX_LOOKBACK_SECONDS * 1000,
      }));
      const keepFromByte = Math.min(pcm.length, Math.max(0, Math.round((nextRequestStartMs - windowStartAudioMs) * 16000 * 2 / 1000)));
      rollingAudioChunks = [pcm.subarray(keepFromByte), pendingAudio].filter((chunk) => chunk.length);
      rollingAudioBytes = rollingAudioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      rollingAudioStartMs = nextRequestStartMs;
      rollingCommitCursorMs = commitEndAudioMs;
      rollingSpeechIntervals = rollingSpeechIntervals.filter((interval) => Number(interval.endMs || Number.MAX_SAFE_INTEGER) >= rollingAudioStartMs);
      correctionSucceeded = true;
      safeSend({ type: "status", status: "rolling_correction_complete", windowStartAudioMs, windowEndAudioMs, ...result });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pendingAudio = Buffer.concat(rollingAudioChunks);
      // 失败窗口独立保留重试，不能再拼回实时缓冲；否则等待期间新增音频会让下一次请求无限变大。
      // 结构化失败状态：rolling 文件 ASR 失败必须分别有状态码和原因（超时/LLM 失败/队列满），
      // 前端同一类失败只提示一次或合并计数，不得刷屏。
      let failureCode = "rolling_asr_failed";
      let failureReason = message;
      if (message.includes("timeout") || message.includes("timed out")) {
        failureCode = "rolling_asr_timeout";
        failureReason = "文件 ASR 超时";
      } else if (message.includes("queue") || message.includes("too many")) {
        failureCode = "rolling_asr_queue_full";
        failureReason = "文件 ASR 队列满";
      } else if (message.includes("llm") || message.includes("alignment")) {
        failureCode = "rolling_llm_alignment_failed";
        failureReason = "LLM 对齐失败";
      }
      if (pcm.length) {
        // 失败窗口最多保留 3 个（音频在源录音里本来就有，重试失败可从源音频重建）。
        // AIT 持续故障时无上限堆积 PCM 会把进程内存吃光。
        while (failedRollingWindows.length >= 3) failedRollingWindows.shift();
        failedRollingWindows.push({
          pcm,
          startTranscriptId: correctionStartId,
          endTranscriptId: correctionEndId,
          trimLeadingSeconds: correctionTrimLeadingSeconds,
          trimTrailingSeconds: correctionTrimTrailingSeconds,
          windowStartAudioMs,
          windowEndAudioMs,
          centerStartAudioMs: plan.centerStartMs,
          centerEndAudioMs: plan.centerEndMs,
          sourceSpeechIntervals: plan.speechIntervals,
          forcedBoundary: plan.forcedBoundary,
          attempt: 0,
          failureCode,
          failureReason,
          failedAt: Date.now(),
        });
      }
      safeSend({ type: "status", status: "rolling_correction_failed", windowStartAudioMs, windowEndAudioMs, failureCode, failureReason });
      const retryStartMs = Math.max(windowStartAudioMs, deps.findRollingContextStart({
        commitStartMs: plan.commitStartMs,
        speechIntervals: plan.speechIntervals,
        baseLookbackMs: deps.config.ROLLING_ASR_OVERLAP_SECONDS * 1000,
        maxLookbackMs: deps.config.ROLLING_ASR_MAX_LOOKBACK_SECONDS * 1000,
      }));
      const retryKeepFromByte = Math.min(pcm.length, Math.max(0, Math.round((retryStartMs - windowStartAudioMs) * 16000 * 2 / 1000)));
      rollingAudioChunks = [pcm.subarray(retryKeepFromByte), pendingAudio].filter((chunk) => chunk.length);
      rollingAudioBytes = rollingAudioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      rollingAudioStartMs = retryStartMs;
      console.error(`[rolling-asr] failed meeting=${meetingId}: ${message}`);
      safeSend({ type: "status", status: "rolling_correction_failed", message, submittedDurationSeconds: Number((pcm.length / (16000 * 2)).toFixed(1)) });
      return null;
    } finally {
      rollingCorrectionRunning = false;
      const shouldSealTail = rollingFinalRequested;
      rollingFinalRequested = false;
      const shouldDrainQueued = rollingCorrectionQueued || Boolean(getRollingWindowPlan(false));
      rollingCorrectionQueued = false;
      // 只有本轮确实完成了文件校准，才继续递归处理尾部。若没有可对齐的
      // transcript 行，继续用同一段 tail 重入会无限递归并压垮 Node 进程。
      // 同时要求绝对音频起点确实前移；这是独立于 ASR 返回内容的硬保险，
      // 防止异常时间戳让同一窗口在会议封存阶段被反复提交。
      const previousCommitCursorMs = Number(rollingCommitCursorBeforeCorrection || 0);
      const rollingTimelineAdvanced = rollingAudioStartMs > windowStartAudioMs + 100
        || rollingCommitCursorMs > previousCommitCursorMs + 100;
      if (correctionSucceeded && !rollingTimelineAdvanced) {
        console.error(`[rolling-asr] stopped non-progressing final drain meeting=${meetingId} start=${windowStartAudioMs} next=${rollingAudioStartMs}`);
      }
      if (correctionSucceeded && rollingTimelineAdvanced && (isFinal || shouldSealTail) && getRollingWindowPlan(true)) {
        // 递归尾窗必须沿用本次 seal 的 AbortSignal。此前这里传入 0，下一扇
        // 窗口会在 deadline 后继续落库，和 forced realtime fallback 双写。
        await triggerRollingCorrection(true, sealingAbortSignal || abortSignal);
      }
      if (!isFinal && correctionSucceeded && shouldDrainQueued && !rollingRetryRunning) {
        // 用户已点击结束时，原本会中队列的下一扇也必须升级为 final，并继承
        // seal deadline；不能先按非 final 路径提交一个脱离 deadline 的窗口。
        void triggerRollingCorrection(Boolean(sealingAbortSignal), sealingAbortSignal);
      }
      if (!isFinal && failedRollingWindows.length) scheduleFailedRollingRetry();
      deps.endMeetingAiJob(meetingId);
    }
  }

  function scheduleFailedRollingRetry() {
    if (rollingRetryTimer || rollingRetryRunning || !failedRollingWindows.some((window) => Number(window.attempt || 0) < deps.config.ROLLING_ASR_MAX_RETRIES)) return;
    const nextAttempt = Math.min(...failedRollingWindows.map((window) => Number(window.attempt || 0)));
    const delay = Math.min(60_000, 5_000 * 2 ** Math.max(0, nextAttempt));
    rollingRetryTimer = setTimeout(() => {
      rollingRetryTimer = null;
      void retryFailedRollingWindows(false, sealingAbortSignal);
    }, delay);
  }

  async function retryFailedRollingWindows(isFinal, abortSignal = null) {
    if (rollingRetryRunning) return false;
    rollingRetryRunning = true;
    deps.beginMeetingAiJob(meetingId);
    let allResolved = true;
    try {
      while (failedRollingWindows.length) {
        if (abortSignal?.aborted) {
          allResolved = false;
          break;
        }
        const pending = failedRollingWindows.shift();
        if (!pending) continue;
        if (pending.attempt >= deps.config.ROLLING_ASR_MAX_RETRIES) {
          failedRollingWindows.unshift(pending);
          allResolved = false;
          break;
        }
        try {
          const submittedDurationSeconds = Number((pending.pcm.length / (16000 * 2)).toFixed(1));
          console.log(`[rolling-asr] retrying meeting=${meetingId} duration=${submittedDurationSeconds}s start=${pending.startTranscriptId} end=${pending.endTranscriptId}`);
          safeSend({ type: "status", status: "rolling_correction", model: deps.config.ROLLING_ASR_MODEL, retry: true, submittedDurationSeconds });
          const result = await deps.performRollingTranscriptCorrection({
            meetingId,
            pcm: pending.pcm,
            startTranscriptId: pending.startTranscriptId,
            endTranscriptId: pending.endTranscriptId,
            model: deps.config.ROLLING_ASR_MODEL,
            trimLeadingSeconds: pending.trimLeadingSeconds,
            trimTrailingSeconds: pending.trimTrailingSeconds,
            windowStartAudioMs: pending.windowStartAudioMs,
            windowEndAudioMs: pending.windowEndAudioMs,
            centerStartAudioMs: pending.centerStartAudioMs,
            centerEndAudioMs: pending.centerEndAudioMs,
            sourceSpeechIntervals: pending.sourceSpeechIntervals,
            forcedBoundary: Boolean(pending.forcedBoundary),
            allowBoundaryRows: Boolean(isFinal),
            abortSignal,
          });
          if (abortSignal?.aborted) {
            allResolved = false;
            failedRollingWindows.unshift(pending);
            break;
          }
          rollingStartTranscriptId = Math.max(rollingStartTranscriptId, Number(result.lastProcessedTranscriptId || pending.startTranscriptId));
          rollingWindowHasOverlap = true;
          safeSend({ type: "status", status: "rolling_correction_complete", retry: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pending.attempt += 1;
          failedRollingWindows.unshift(pending);
          allResolved = false;
          console.error(`[rolling-asr] retry failed meeting=${meetingId}: ${message}`);
          safeSend({ type: "status", status: "rolling_correction_failed", retry: true, message });
          break;
        }
      }
    } finally {
      rollingRetryRunning = false;
      deps.endMeetingAiJob(meetingId);
    }
    if (!abortSignal?.aborted && !allResolved && failedRollingWindows.some((window) => Number(window.attempt || 0) < deps.config.ROLLING_ASR_MAX_RETRIES)) scheduleFailedRollingRetry();
    if (allResolved && getRollingWindowPlan(false)) void triggerRollingCorrection(false);
    return allResolved;
  }

  function scheduleTranscriptFlush(reason = "endpoint", options = {}) {
    // 连续说话时上游会持续发 SentenceEnd。保留第一个句界的 deadline，
    // 不让后续句界不断把草稿落库推迟；这样浏览器 VAD 缺失时也能稳定产出草稿。
    if (transcriptFlushTimer && transcriptFlushReason === "sentence_end" && reason === "sentence_end") return;
    if (transcriptFlushTimer) clearTimeout(transcriptFlushTimer);
    const delay = getTranscriptFlushDelay(reason);
    transcriptFlushReason = reason;
    transcriptFlushTimer = setTimeout(() => {
      transcriptFlushTimer = null;
      transcriptFlushReason = "";
      void flushTranscriptBuffer(reason, options);
    }, delay);
    safeSend({ type: "status", status: "stabilizing_transcript", reason, delay });
  }

  function clearPartialProgressTimer() {
    if (partialProgressTimer) {
      clearTimeout(partialProgressTimer);
      partialProgressTimer = null;
    }
  }

  function resetPartialProgressState() {
    clearPartialProgressTimer();
    partialProgressCommittedText = "";
    partialProgressLastAudioEndMs = 0;
  }

  function findPartialCommitBoundary(text) {
    const value = String(text || "");
    const punctuation = /[。！？!?；;，,、：:]/g;
    let last = -1;
    let match;
    while ((match = punctuation.exec(value))) last = match.index + match[0].length;
    const minChars = Math.max(8, Number(config.ASR_PARTIAL_PROGRESS_MIN_CHARS || 24));
    const maxChars = Math.max(minChars, Number(config.ASR_PARTIAL_PROGRESS_MAX_CHARS || 120));
    if (last >= minChars) return Math.min(last, maxChars);
    if (value.length >= maxChars) return maxChars;
    return 0;
  }

  function schedulePartialProgressFlush() {
    if (partialProgressTimer || upstreamStopped || stopRequested || transcriptBuffer || !latestPartial) return;
    const delay = Math.max(3_000, Number(config.ASR_PARTIAL_PROGRESS_INTERVAL_MS || 5_000));
    partialProgressTimer = setTimeout(() => {
      partialProgressTimer = null;
      const candidate = deps.normalizeTranscriptSegment(latestPartial);
      if (!candidate || candidate.length < Math.max(8, Number(config.ASR_PARTIAL_PROGRESS_MIN_CHARS || 24))) return;

      // 上游返回的是“从句首到当前”的快照。只提交尚未落稿的前缀，
      // 避免每 12 秒把整句重复插入；若上游回改了前缀，则从新快照重新开始。
      const delta = getUncommittedCumulativeText(partialProgressCommittedText, candidate);
      const continuesCommittedSnapshot = Boolean(partialProgressCommittedText) && delta !== candidate;
      const commitLength = findPartialCommitBoundary(delta);
      if (!commitLength) {
        schedulePartialProgressFlush();
        return;
      }
      const commitText = deps.normalizeTranscriptSegment(delta.slice(0, commitLength));
      if (!commitText) {
        schedulePartialProgressFlush();
        return;
      }

      const currentAudioMs = getTranscriptAudioOffsetMs();
      const estimatedStartMs = partialProgressLastAudioEndMs > 0
        ? partialProgressLastAudioEndMs
        : Math.max(0, currentAudioMs - Math.max(1_000, delay));
      transcriptBuffer = commitText;
      transcriptBufferStartedAudioMs = Math.min(estimatedStartMs, currentAudioMs);
      transcriptBufferStartedAt = deps.formatMeetingElapsedTime(transcriptBufferStartedAudioMs / 1000);
      transcriptBufferEndAudioMs = Math.max(transcriptBufferStartedAudioMs + 1, currentAudioMs);
      // 候选累计快照可能回改已提交区间中的少量词，不能再用“旧文本 + 增量”
      // 拼接游标；直接保留本次候选中已消费到的位置，下一次才能继续正确裁尾。
      partialProgressCommittedText = continuesCommittedSnapshot
        ? candidate.slice(0, Math.max(0, candidate.length - delta.length) + commitText.length)
        : commitText;
      partialProgressLastAudioEndMs = transcriptBufferEndAudioMs;
      latestPartial = "";
      safeSend({
        type: "status",
        status: "partial_progress_flush",
        audioStartMs: transcriptBufferStartedAudioMs,
        audioEndMs: transcriptBufferEndAudioMs,
        textLength: commitText.length,
      });
      void flushTranscriptBuffer("partial_progress");
    }, delay);
  }

  function getTranscriptFlushDelay(reason = "endpoint") {
    if (["stop", "client_close", "upstream_close", "max_text", "max_duration"].includes(reason)) {
      return Math.max(0, config.ASR_FINAL_STABILITY_DELAY_MS);
    }
    if (reason === "sentence_end") return Math.max(0, config.ASR_FINAL_STABILITY_DELAY_MS);
    const candidate = deps.normalizeTranscriptSegment(transcriptBuffer || latestPartial);
    if (deps.shouldWaitForMoreSpeech(candidate)) return Math.max(config.ASR_SHORT_MERGE_DELAY_MS, config.ASR_FINAL_STABILITY_DELAY_MS);
    if (deps.looksSemanticallyIncomplete(candidate)) return Math.max(config.ASR_INCOMPLETE_MERGE_DELAY_MS, config.ASR_FINAL_STABILITY_DELAY_MS);
    return Math.max(0, config.ASR_FINAL_STABILITY_DELAY_MS);
  }

  function pushTranscriptSegment(text, timing = {}) {
    const segment = deps.normalizeTranscriptSegment(text);
    if (!segment) return null;
    const timedStartMs = Number.isFinite(Number(timing.startMs)) ? Number(timing.startMs) : null;
    const timedEndMs = Number.isFinite(Number(timing.endMs)) ? Number(timing.endMs) : null;
    // 纯 filler 片段不单独入 buffer，但保留时间戳
    if (deps.isFillerOnly(segment)) {
      if (!transcriptBufferStartedAt) {
        transcriptBufferStartedAudioMs = timedStartMs ?? pendingSpeechStartAudioMs ?? getTranscriptAudioOffsetMs();
        transcriptBufferStartedAt = timedStartMs !== null ? deps.formatMeetingElapsedTime(transcriptBufferStartedAudioMs / 1000) : (pendingSpeechStartAt || getTranscriptTimeLabel());
      }
      if (timedEndMs !== null) transcriptBufferEndAudioMs = Math.max(transcriptBufferEndAudioMs, timedEndMs);
      return null;
    }
    // 清理 filler 词
    const cleanedSegment = deps.removeFillerWords(segment);
    if (!cleanedSegment) return null;

    // SentenceEnd 是流式模型已经确认的句界。它会在短延迟后直接写入服务端
    // 草稿时间轴；不再额外创建只能靠模糊规则清理的浏览器预览行。这样时间轴
    // 始终只有一个权威来源：持久化草稿或文件 ASR 稳定稿。
    if (!transcriptBuffer) {
      transcriptBufferStartedAudioMs = timedStartMs ?? pendingSpeechStartAudioMs ?? getTranscriptAudioOffsetMs();
      transcriptBufferStartedAt = timedStartMs !== null ? deps.formatMeetingElapsedTime(transcriptBufferStartedAudioMs / 1000) : (pendingSpeechStartAt || getTranscriptTimeLabel());
    }
    if (timedEndMs !== null) transcriptBufferEndAudioMs = Math.max(transcriptBufferEndAudioMs, timedEndMs);
    transcriptBuffer = deps.mergeTranscriptText(transcriptBuffer, cleanedSegment);

    client.send(JSON.stringify({ type: "transcript.buffered", text: transcriptBuffer }));
    if (deps.shouldFlushTranscriptBuffer(transcriptBuffer, cleanedSegment)) return void flushTranscriptBuffer("max_text");
    return null;
  }

  // flush 串行队列：同一会议同一时刻只允许一个 flush 执行（声纹/落库耗时，
  // 并发 flush 会导致落库乱序、去重判断失真）。后续 flush 排队等前一个完成。
  // 关键：入队前立即冻结不可变快照（文本/时间/音频块/VAD 状态），队列只消费快照——
  // 防止排队期间后续句子混入共享缓冲导致 B+C 被当作一段处理。
  let flushChain = Promise.resolve();
  function enqueueFlush(reason, options) {
    // 入队瞬间冻结快照——后续 SentenceEnd 会写新的 transcriptBuffer，不影响本次 flush。
    // capturedAtAudioMs：入队时的当前音频偏移量——flushTranscriptBufferInner 在缺少 ASR 句尾时间戳时
    // 只能用快照的 capturedAtAudioMs（不是排队任务真正执行时的当前会议时间），防止前一段耗时较长时
    // 扩大前一段时间区间（影响稳定稿对齐、去重和回放定位）。
    let snapshotLatestPartial = latestPartial;
    if (!transcriptBuffer && options?.fallbackToPartial && snapshotLatestPartial) {
      const cumulativeCandidate = deps.normalizeTranscriptSegment(snapshotLatestPartial);
      snapshotLatestPartial = deps.normalizeTranscriptSegment(
        getUncommittedCumulativeText(partialProgressCommittedText, cumulativeCandidate),
      );
      // 入队即占用这一累计前缀，避免排队期间另一个 endpoint/定时器
      // 再把同一快照入队。若上游下一次确实从新句开始，前缀不匹配会自然
      // 返回完整新句，不会吞掉真实发言。
      if (cumulativeCandidate) {
        partialProgressCommittedText = cumulativeCandidate;
        partialProgressLastAudioEndMs = getTranscriptAudioOffsetMs();
      }
    }
    const snapshot = {
      text: transcriptBuffer,
      startedAt: transcriptBufferStartedAt,
      startedAudioMs: transcriptBufferStartedAudioMs,
      endAudioMs: transcriptBufferEndAudioMs,
      capturedAtAudioMs: getTranscriptAudioOffsetMs(),
      audioChunks: [...speechAudioChunks],
      audioBytes: speechAudioBytes,
      pendingSpeechStart: pendingSpeechStartAt,
      pendingSpeechStartAudioMs,
      latestPartial: snapshotLatestPartial,
    };
    // 立即清空活动缓冲——新句子从空 buffer 开始，不与本次 flush 混。
    transcriptBuffer = "";
    transcriptBufferStartedAt = "";
    transcriptBufferStartedAudioMs = 0;
    transcriptBufferEndAudioMs = 0;
    pendingSpeechStartAt = "";
    pendingSpeechStartAudioMs = null;
    latestPartial = "";
    speechAudioChunks = [];
    speechAudioBytes = 0;

    flushChain = flushChain.then(() => flushTranscriptBufferInner(reason, options, snapshot)).catch((err) => {
      console.error(`[transcript] flush chain error meeting=${meetingId}: ${err instanceof Error ? err.message : err}`);
    });
    return flushChain;
  }

  async function flushTranscriptBuffer(reason = "endpoint", options = {}) {
    return enqueueFlush(reason, options);
  }

  async function flushTranscriptBufferInner(reason = "endpoint", options = {}, snapshot = null) {
    if (transcriptFlushTimer) {
      clearTimeout(transcriptFlushTimer);
      transcriptFlushTimer = null;
      transcriptFlushReason = "";
    }
    // 用快照（入队时冻结的不可变状态），不用全局变量——防止排队期间后续句子混入。
    const snap = snapshot || {
      text: transcriptBuffer,
      startedAt: transcriptBufferStartedAt,
      startedAudioMs: transcriptBufferStartedAudioMs,
      endAudioMs: transcriptBufferEndAudioMs,
      audioChunks: speechAudioChunks,
      pendingSpeechStart: pendingSpeechStartAt,
      pendingSpeechStartAudioMs,
      latestPartial,
    };
    let text = deps.normalizeTranscriptSegment(snap.text);
    const usingPartialFallback = !text && Boolean(options.fallbackToPartial);
    if (usingPartialFallback) text = deps.normalizeTranscriptSegment(snap.latestPartial);
    // 快照前缀抑制：与上次兜底落库文本相同或是其前缀扩展时跳过——
    // 这句话仍在进行中，等 SentenceEnd 或更长的停顿再落，避免同一句话
    // 被反复落库成"前缀累积"重复行（英文 LM 快照场景的总根因）。
    // 仅抑制常规 endpoint 兜底；stop/close/seal 等终结性 flush 必须落最终文本。
    if (reason === "endpoint" && usingPartialFallback && text && lastPartialFlushText
        && (text === lastPartialFlushText || text.startsWith(lastPartialFlushText))) {
      return null;
    }
    // 保存真正的 ASR 原文（normalize 后但未去 filler），用于审计对比
    const rawAsrText = text;
    if (!text) {
      return null;
    }
    // 这条计时覆盖用户可见的关键路径：上游确认句末/partial 兜底 -> 草稿成功落库。
    // 不把词库查询、LLM、声纹、分段 WAV 等后台工作计入其中，避免它们拖慢时间轴。
    const draftPersistStartedAt = Date.now();
    // 最终落库前再次清理 filler
    text = deps.removeFillerWords(text);
    if (!text || deps.isFillerOnly(text)) {
      transcriptBuffer = "";
      transcriptBufferEndAudioMs = 0;
      if (pendingSpeechStartAudioMs === null) transcriptBufferStartedAt = "";
      latestPartial = "";
      return null;
    }
    const startedAt = snap.startedAt || getTranscriptTimeLabel();
    // 0 是合法的会议起始时间，不能用 || 把它误判成“未设置”，否则首段
    // 会被错误地标到当前音频位置，后续文件 ASR 对齐会整体偏移。
    const audioStartMs = snap.startedAt
      ? Number(snap.startedAudioMs || 0)
      : getTranscriptAudioOffsetMs();
    const currentAudioChunks = snap.audioChunks;
    const quality = deps.analyzePcmQuality(currentAudioChunks);
    // 缺少 ASR 句尾时间戳时，只能用快照的 capturedAtAudioMs（入队时冻结）——
    // 禁止用排队任务真正执行时的当前会议时间（getTranscriptAudioOffsetMs()），
    // 防止前一段耗时较长时扩大前一段时间区间。
    const capturedAtAudioMs = Number(snap.capturedAtAudioMs || 0);
    const timedEndMs = Number(snap.endAudioMs || 0);
    const pcmDerivedEndMs = audioStartMs + Math.max(0, Number(quality.durationMs || 0));
    const audioEndMs = timedEndMs > 0
      ? Math.max(audioStartMs, timedEndMs)
      : Math.max(audioStartMs, pcmDerivedEndMs, capturedAtAudioMs);
    // 只读取已预热的会话缓存；这里绝不能再次查询数据库。慢词库/声纹/LLM
    // 都只能影响后续稳定稿或独立补偿，不能让已确认句末滞留在顶部实时气泡。
    const hotwords = cachedAsrHotwords;
    const glossaryEntries = cachedGlossaryEntries;
    if (usingPartialFallback) {
      lastPartialFlushText = text;
      lastPartialFlushAudioStartMs = snap.startedAt
        ? Number(snap.startedAudioMs || 0)
        : getTranscriptAudioOffsetMs();
    } else {
      // 正常 flush（SentenceEnd 进 buffer）说明快照句子已终结，重置快照跟踪。
      lastPartialFlushText = "";
      lastPartialFlushAudioStartMs = 0;
    }
    // 全局缓冲已在入队时清空（enqueueFlush 里），这里仅做轻量、确定性的草稿
    // 处理。分段 WAV、实时声纹、逐句 LLM 和 diarization 都由稳定稿/后台补偿承担，
    // 不能位于这条用户可见的落库关键路径上。
    const correctedText = deps.applyGlossaryAliasCorrections(text, glossaryEntries) || text;

    const lineDrafts = await deps.buildTranscriptLineDrafts({
      meetingId,
      startedAt,
      text: correctedText,
      fallbackSpeaker: {
        speaker: currentProvisionalSpeaker,
        source: "realtime_provisional",
        confidence: 20,
      },
      audioPath: "",
      wav: null,
      diarizationSegments: [],
      audioStartMs,
      audioEndMs,
    });
    // P0：Adapter 可能返回 Promise（公司端 async），core 统一 await Promise.resolve。
    const timelineLineDrafts = await Promise.resolve(deps.normalizeTranscriptDraftTimeline(meetingId, lineDrafts, quality));

    // 上游可能重发相邻 SentenceEnd，也可能把 partial-progress 的前缀再作为
    // SentenceEnd 发送。二者都只能保留一条草稿；45 秒文件稿会继续覆盖它。
    const lastFlushed = lastFlushedTranscript;
    if (lastFlushed && correctedText && shouldSuppressLiveTranscriptDuplicate(lastFlushed, {
      text: correctedText,
      audioStartMs,
      audioEndMs,
      reason,
    })) {
      console.log(`[transcript] dedupe skip meeting=${meetingId}: reason=${reason} previous=${lastFlushed.reason || "unknown"}`);
      return null;
    }

    const correctionApplied = deps.normalizeTranscriptSegment(correctedText) !== deps.normalizeTranscriptSegment(text);
    const correctionReason = correctionApplied ? "glossary" : "";
    const insertedLines = [];
    try {
      for (const draft of timelineLineDrafts) {
        // 必须 await：公司端 insertTranscript 是 async，直接 push Promise 会让
        // transcript.final 序列化成空对象（前端空行）且 stabilityStatus 判断失效。
        insertedLines.push(await deps.insertTranscript({
          ...draft,
          rawText: rawAsrText,
          correctionApplied,
          correctionReason,
          asrModel: model,
          flushReason: reason,
          quality,
          hotwords,
        }));
      }
      lastFlushedTranscript = { text: correctedText, audioStartMs, audioEndMs, reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[transcript] insert failed meeting=${meetingId}: ${message}`);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "transcript.error", text: correctedText || text, reason: `落库失败：${message}` }));
      }
      return null;
    }
    // 快照机制已下线（两端纪要统一实时查 transcripts 表）；保留可选调用兼容旧端侧注入。
    deps.refreshMeetingTranscriptSnapshotDebounced?.(meetingId);
    const draftPersistLatencyMs = Date.now() - draftPersistStartedAt;
    for (const line of insertedLines) {
      // 浏览器时间轴只接受已持久化的行；不再发客户端临时分段及其 replacement hint。
      // 稳定稿以数据库的原子中心区间替换为准，前端下一次 state 刷新直接反映该结果。
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "transcript.final", line }));
      if (line.stabilityStatus === "stable") deps.scheduleServerAutoAnalyze(meetingId, line.stableRevision);
    }
    // 声纹识别绝不能回到草稿关键路径。按配置间隔抽取一条足够长的句子，
    // 串行交给会议级轨道管理器；识别完成后以同一个 transcript id 原位更新。
    const identifyIntervalMs = Math.max(2_000, Number(config.LIVE_SPEAKER_IDENTIFY_INTERVAL_MS || 12_000));
    const shouldIdentifySpeaker = Boolean(
      typeof deps.identifySpeakerFromAudio === "function"
      && typeof deps.updateTranscriptSpeakerAuto === "function"
      && insertedLines.length
      && currentAudioChunks.some((chunk) => Buffer.isBuffer(chunk) && chunk.length)
      && audioEndMs - audioStartMs >= 1_200
      && audioEndMs - lastSpeakerIdentifyAudioMs >= identifyIntervalMs
    );
    if (shouldIdentifySpeaker) {
      lastSpeakerIdentifyAudioMs = audioEndMs;
      const pcm = Buffer.concat(currentAudioChunks.filter((chunk) => Buffer.isBuffer(chunk) && chunk.length));
      const transcriptIds = insertedLines.map((line) => Number(line.id || 0)).filter((id) => id > 0);
      const fallbackSpeaker = currentProvisionalSpeaker;
      speakerEnrichmentChain = speakerEnrichmentChain
        .catch(() => undefined)
        .then(async () => {
          const result = await deps.identifySpeakerFromAudio({
            meetingId,
            wav: wrapPcm16AsWav(pcm, 16000),
            audioPath: "",
            fallbackSpeaker,
          });
          if (!result?.speaker || result.speaker === "待识别") return;
          currentProvisionalSpeaker = result.speaker;
          let updatedCount = 0;
          for (const id of transcriptIds) {
            const updated = await deps.updateTranscriptSpeakerAuto(
              id,
              result.speaker,
              result.confidence,
              result.source || "embedding",
            );
            if (!updated) continue;
            updatedCount += 1;
            // 复用 transcript.final 的按 id 替换语义，不增加新的前端事件协议。
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "transcript.final", line: updated }));
          }
          safeSend({ type: "status", status: "realtime_speaker_enrichment_complete", updatedCount });
        })
        .catch((error) => {
          console.warn(`[speaker/realtime] meeting=${meetingId} failed: ${error instanceof Error ? error.message : error}`);
        });
    }
    safeSend({
      type: "status",
      status: "draft_persisted",
      reason,
      lineCount: insertedLines.length,
      latencyMs: draftPersistLatencyMs,
    });
    console.info(`[transcript] draft persisted meeting=${meetingId} reason=${reason} lines=${insertedLines.length} latencyMs=${draftPersistLatencyMs}`);
    return insertedLines.at(-1) || null;
  }

  function stopUpstream() {
    clearInterval(clientPingTimer);
    resetPartialProgressState();
    upstreamStopped = true;
    if (upstreamReconnectTimer) {
      clearTimeout(upstreamReconnectTimer);
      upstreamReconnectTimer = null;
    }
    if (silenceKeepaliveTimer) {
      clearInterval(silenceKeepaliveTimer);
      silenceKeepaliveTimer = null;
    }
    if (upstreamRotationTimer) {
      clearTimeout(upstreamRotationTimer);
      upstreamRotationTimer = null;
    }
    if (!upstream) return;
    if (upstream._pingTimer) { clearInterval(upstream._pingTimer); upstream._pingTimer = null; }
    if (upstream.readyState !== WebSocket.OPEN) {
      upstream.terminate();
      return;
    }
    upstream.send(JSON.stringify({
      header: {
        message_id: randomUUID(),
        task_id: upstreamTaskId,
        namespace: "SpeechTranscriber",
        name: "StopTranscription",
        appkey: "default",
      },
      payload: {},
    }));
    setTimeout(() => {
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, "client stopped");
    }, 500);
  }
}
