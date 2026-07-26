/**
 * live-asr-session.mjs —— 实时 ASR 会话（两端共用）。
 * WebSocket 实时转写核心：上游连接管理、PCM 缓冲、转写推送、滚动窗口调度、
 * 断线恢复、失败重试、会后封存。
 *
 * 通过 deps 注入端侧差异（DB 方言/鉴权/配置/存储），业务逻辑两端统一。
 */

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
    client.close(1011, "missing api key");
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
    client.close(1011, "meeting already has an active connection");
    return;
  }
  meetingLiveConnections.set(meetingId, client);
  // server→client 心跳：浏览器收到 WS ping 会自动回 pong。音频暂停（静音/后台标签页）
  // 时仍有双向流量，防止公司入口网关/nginx 因空闲超时切断长连接（公网 nginx 同理）。
  clientPingTimer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch { /* gone */ }
    }
  }, 25_000);
  const requestedModel = clientUrl.searchParams.get("model") || "";
  const model = deps.resolveRequestedAsrModel(requestedModel, deps.config.AIT_ASR_MODEL);
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
  let realtimeSegmentSequence = 0;
  let speechAudioChunks = [];
  let speechAudioBytes = 0;
  let pendingAudioChunks = [];
  let pendingAudioBytes = 0;
  let upstream = null;
  let upstreamReconnectTimer = null;
  let upstreamReconnectAttempt = 0;
  let upstreamTaskAudioBaseMs = 0;
  let upstreamTimestampClampCount = 0;
  let upstreamStopped = false;
  let silenceKeepaliveTimer = null;
  let lastAudioSentAt = 0;
  let transcriptFlushTimer = null;
  let transcriptFlushReason = "";
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
  let sealingPromise = null;
  let stopRequested = false;
  let lastSpeakerIdentifyAt = 0;
  let latestSpeakerResult = null;
  // 会议时间轴只由已经持久化的 PCM 样本数决定。elapsed_seconds 是展示缓存，
  // 不能再和源 WAV 时长相加，否则暂停/断线后恢复会把旧时长重复计算。
  const sourceAudioState = deps.ensureMeetingSourceAudio(meetingId, { markRecording: true });
  const sessionAudioBaseBytes = Math.max(0, Number(sourceAudioState.scheduledBytes ?? sourceAudioState.bytes ?? 0));
  const sessionAudioBaseMs = Math.round(sessionAudioBaseBytes / (16000 * 2) * 1000);
  const sessionAudioBaseSample = Math.floor(sessionAudioBaseBytes / 2);
  let receivedAudioBytes = 0;
  let pendingAudioChunkMeta = null;
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

  safeSend({ type: "status", status: "connecting", model });
  safeSend({
    type: "status",
    status: "source_audio_ready",
    sampleRate: 16000,
    nextSample: sessionAudioBaseSample,
    nextAudioMs: sessionAudioBaseMs,
  });

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

    current.on("open", () => {
      if (current !== upstream || upstreamStopped) return;
      upstreamOpen = true;
      // 从数据库查询项目热词，传入 ASR 识别时生效
      let hotwordText = "";
      try {
        const allTerms = deps.getAsrHotwordsForMeeting(meetingId);
        if (allTerms.length) hotwordText = allTerms.join(",");
      } catch { /* ignore glossary errors */ }

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
        while (pendingAudioChunks.length) {
          const chunk = pendingAudioChunks.shift();
          if (current.readyState === WebSocket.OPEN) current.send(chunk, { binary: true });
        }
        pendingAudioBytes = 0;
        // 静音保活：每 10s 检查一次，如果距上次发音频超过 10s，补发静音帧
        if (silenceKeepaliveTimer) clearInterval(silenceKeepaliveTimer);
        silenceKeepaliveTimer = setInterval(() => {
          if (current !== upstream || current.readyState !== WebSocket.OPEN || !started) return;
          if (Date.now() - lastAudioSentAt < 10000) return;
          const silenceFrame = Buffer.alloc(3200); // 100ms 静音 PCM @16k/16bit
          try { current.send(silenceFrame, { binary: true }); } catch { /* gone */ }
        }, 10000);
        safeSend({ type: "status", status: "started", model });
        return;
      }

      if (name === "TranscriptionResultChanged" && result) {
        latestPartial = result;
        safeSend({ type: "transcript.partial", text: result });
        return;
      }

      if (name === "SentenceEnd" && result) {
        const payload = message?.payload || {};
        pushTranscriptSegment(result, {
          startMs: mapUpstreamAudioTime(payload.begin_time ?? payload.beginTime ?? payload.start_time ?? payload.startTime),
          endMs: mapUpstreamAudioTime(payload.end_time ?? payload.endTime ?? payload.time),
        });
        return;
      }

      if (name === "TranscriptionFailed" || name === "TASK_FAILED") {
        const messageText = message?.header?.status_message || "ASR failed";
        console.error(`[asr] upstream task failed meeting=${meetingId}: ${messageText}`);
        safeSend({ type: "status", status: "upstream_reconnecting", reason: messageText });
        if (current.readyState === WebSocket.OPEN) current.close(1011, "task failed");
        scheduleUpstreamReconnect("task_failed");
        return;
      }

      safeSend({ type: "event", name, payload: message?.payload || {} });
    });

    current.on("close", (code, reason) => {
      if (current !== upstream || upstreamStopped) return;
      upstreamOpen = false;
      started = false;
      if (current._pingTimer) { clearInterval(current._pingTimer); current._pingTimer = null; }
      if (silenceKeepaliveTimer) { clearInterval(silenceKeepaliveTimer); silenceKeepaliveTimer = null; }
      const reasonText = reason.toString();
      console.error(`[asr] upstream closed meeting=${meetingId} code=${code} reason=${reasonText || "none"}`);
      void flushTranscriptBuffer("upstream_close", { fallbackToPartial: true });
      scheduleUpstreamReconnect(reasonText || `code ${code}`);
    });

    current.on("error", (error) => {
      if (current !== upstream || upstreamStopped) return;
      console.error(`[asr] upstream error meeting=${meetingId}: ${error.message}`);
      safeSend({ type: "status", status: "upstream_reconnecting", reason: error.message });
    });
  }

  function scheduleUpstreamReconnect(reason = "upstream closed") {
    if (upstreamStopped || client.readyState !== WebSocket.OPEN) return;
    if (upstreamReconnectTimer) clearTimeout(upstreamReconnectTimer);
    upstreamReconnectAttempt += 1;
    const delay = Math.min(800 * 2 ** Math.min(upstreamReconnectAttempt - 1, 4), 8_000);
    safeSend({ type: "status", status: "upstream_reconnecting", reason, attempt: upstreamReconnectAttempt, delay });
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
        if (transcriptFlushTimer) {
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
        if (activeRollingSpeech) {
          activeRollingSpeech.endMs = getTranscriptAudioOffsetMs();
          rollingSpeechIntervals.push(activeRollingSpeech);
          // 校准停滞时区间只增不滤，保留最近 500 段防内存膨胀。
          if (rollingSpeechIntervals.length > 500) rollingSpeechIntervals.splice(0, rollingSpeechIntervals.length - 500);
          activeRollingSpeech = null;
        }
        scheduleTranscriptFlush(control.reason || "endpoint", { fallbackToPartial: true });
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
          void deps.appendMeetingSourceAudio(meetingId, Buffer.alloc(gapBytes)).catch(() => {});
        }
        receivedAudioBytes = Math.max(0, (chunkMeta.startSample - sessionAudioBaseSample) * 2);
      }
    }
    const acceptedSequence = chunkMeta?.sequence;
    const acceptedEndSample = expectedStartSample + Math.floor(chunk.length / 2);
    void deps.appendMeetingSourceAudio(meetingId, chunk).then(() => {
      safeSend({
        type: "status",
        status: "source_audio_committed",
        sampleRate: 16000,
        nextSample: acceptedEndSample,
        sequence: acceptedSequence,
      });
    }).catch((error) => {
      console.error(`[source-audio] append failed meeting=${meetingId}: ${error instanceof Error ? error.message : error}`);
      safeSend({ type: "status", status: "source_audio_error", message: "完整录音保存异常" });
    });
    receivedAudioBytes += chunk.length;
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
    if (upstreamOpen && started && upstream?.readyState === WebSocket.OPEN) {
      upstream.send(chunk, { binary: true });
      lastAudioSentAt = Date.now();
      return;
    }
    if (pendingAudioBytes + chunk.length <= config.ASR_PENDING_AUDIO_MAX_BYTES) {
      pendingAudioChunks.push(chunk);
      pendingAudioBytes += chunk.length;
    } else {
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
      console.error(`[pause] checkpoint failed meeting=${meetingId}: ${error instanceof Error ? error.message : error}`);
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
      console.error(`[seal] persist elapsed failed meeting=${meetingId}: ${error instanceof Error ? error.message : error}`);
    }
    deps.beginMeetingAiJob(meetingId);
    sealingPromise = (async () => {
      await flushTranscriptBuffer(reason, { fallbackToPartial: true });
      // 在真正开始尾段文件 ASR 前先持久化中间状态。这样即使 WebSocket、Pod
      // 或上游请求在中途失联，服务端门禁也能识别为“待收口”并走超时兜底；
      // 不能一直停留在 recording，导致当前这场会议没有可恢复的状态。
      try {
        await deps.markMeetingSourceAudioStabilizing?.(meetingId);
      } catch (error) {
        console.error(`[seal] mark tail stabilizing failed meeting=${meetingId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      // 会中失败窗口可以后台退避重试；用户已点击结束后绝不能继续无界重试，
      // 否则一次文件 ASR 卡住会永久占住归档。尾段本轮限时执行，失败即走实时稿收口。
      // 这里必须对“整个尾段 drain”限时，而不只是单个文件 ASR 请求限时。
      // triggerRollingCorrection 会在 finally 中继续处理下一扇窗口；若某一扇
      // 音频/上游调用一直不返回，之前的单窗 timeout 不能保证 sealMeeting 返回，
      // 前端便会永久停在“尾段校准中”。超时后保留已经产出的稳定稿，并由下方
      // forced-stable 兜底收口，完整源录音仍保留，后续可再次校准。
      let tailDrainCompleted = true;
      try {
        await withTimeout(
          triggerRollingCorrection(true),
          config.TAIL_STABILIZATION_TIMEOUT_MS,
          "tail_stabilization_total",
        );
      } catch (error) {
        tailDrainCompleted = false;
        console.error(`[seal] tail stabilization timed out meeting=${meetingId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const retriesResolved = tailDrainCompleted && failedRollingWindows.length === 0;
      // 等待正在运行的 rolling correction 完成，避免 draftCount 统计不准
      if (rollingCorrectionRunning || rollingRetryRunning) {
        // sealMeeting 自身就是一个进行中的任务。这里只等待并行的滚动校准/重试，
        // 不能把自身也算进“待完成任务”，否则必定等到 120 秒超时。
        await deps.waitForMeetingAiJobs(meetingId, 120_000, 1);
      }
      await deps.finalizeMeetingSourceAudio(meetingId, reason === "stop" ? "complete" : "partial");
      // 完整录音封存后再做一次会议级说话人校准。它不影响文字稳定化，但
      // 最终纪要必须使用这次校准后的说话人轨道，而不是窗口临时标签。
      try {
        const speakerResult = await withTimeout(
          deps.reconcileMeetingSpeakersFromSourceAudio(meetingId),
          config.POST_MEETING_SPEAKER_TIMEOUT_MS,
          "post_meeting_speaker",
        );
        if (!speakerResult.ok) console.warn(`[post-meeting-speaker] skipped meeting=${meetingId}: ${speakerResult.reason || "unknown"}`);
      } catch (error) {
        console.error(`[post-meeting-speaker] failed meeting=${meetingId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const draftCount = await countDraftTranscripts(meetingId);
      const hasPendingRollingRetry = failedRollingWindows.some((window) => Number(window.attempt || 0) < deps.config.ROLLING_ASR_MAX_RETRIES);
      // 文件校准可能因边界/低置信度而没有可重试窗口，但仍留下少量 draft。
      // 此时不能永久停在 sealed_pending_correction；在所有校准任务已收口后，
      // 按既定兜底策略把残留稿标记为 forced stable，保证会议可归档可回放。
      if (draftCount > 0 && !hasPendingRollingRetry && !rollingCorrectionRunning && !rollingRetryRunning) {
        const forced = await forceStabilizeDraftTranscripts(meetingId);
        if (forced > 0) {
          safeSend({ type: "status", status: "sealed", forcedStableCount: forced, message: `已强制收口 ${forced} 条未校准转写` });
          return;
        }
      }
      if (!retriesResolved || draftCount > 0) {
        // 用户明确结束会议后，不能让失败的尾段重试永久占住归档入口。
        // 文件 ASR 的后台重试只适合会中窗口；会后立即以现有实时稿收口，
        // 同时保留完整录音供回听和后续修复，最终纪要永远有可用输入。
        const forced = await forceStabilizeDraftTranscripts(meetingId);
        safeSend({
          type: "status",
          status: "sealed",
          forcedStableCount: forced,
          message: forced > 0
            ? `尾段文件校准未完成，已用 ${forced} 条实时稿收口`
            : "尾段文件校准未完成，已保留现有稳定稿并收口",
        });
        return;
      }
      safeSend({ type: "status", status: "sealed" });
    })().finally(() => deps.endMeetingAiJob(meetingId));
    return sealingPromise;
  }

  async function countDraftTranscripts(meetingIdParam) {
    if (typeof deps.countDraftTranscripts === "function") {
      return Number(await deps.countDraftTranscripts(meetingIdParam)) || 0;
    }
    try {
      const db = deps.openDb();
      const draftCount = db.prepare(
        "SELECT COUNT(*) AS count FROM transcripts WHERE meeting_id = ? AND deleted_at IS NULL AND stability_status <> 'stable'"
      ).get(Number(meetingIdParam))?.count || 0;
      db.close();
      return Number(draftCount || 0);
    } catch (error) {
      console.error(`[seal] count drafts failed meeting=${meetingIdParam}: ${error instanceof Error ? error.message : error}`);
      return Number.MAX_SAFE_INTEGER;
    }
  }

  async function forceStabilizeDraftTranscripts(meetingIdParam) {
    if (typeof deps.forceStabilizeDraftTranscripts === "function") {
      return Number(await deps.forceStabilizeDraftTranscripts(meetingIdParam)) || 0;
    }
    try {
      const db = deps.openDb();
      const draftRows = db.prepare(`
        SELECT id FROM transcripts
        WHERE meeting_id = ? AND deleted_at IS NULL AND stability_status <> 'stable' AND user_edited = 0
      `).all(Number(meetingIdParam));
      if (!draftRows.length) { db.close(); return 0; }
      db.exec("BEGIN IMMEDIATE");
      const stableRevision = deps.bumpMeetingStableRevision(db, Number(meetingIdParam));
      db.prepare(`
        UPDATE transcripts
        SET stability_status = 'stable', stable_revision = ?, correction_consistency = 'forced', quality_status = 'fallback'
        WHERE meeting_id = ? AND deleted_at IS NULL AND stability_status <> 'stable' AND user_edited = 0
      `).run(stableRevision, Number(meetingIdParam));
      db.exec("COMMIT");
      db.close();
      deps.scheduleServerAutoAnalyze(meetingIdParam, stableRevision);
      console.log(`[seal] force stabilized ${draftRows.length} draft transcripts meeting=${meetingIdParam}`);
      return draftRows.length;
    } catch (error) {
      console.error(`[seal] force stabilize failed meeting=${meetingIdParam}: ${error instanceof Error ? error.message : error}`);
      return 0;
    }
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

  async function triggerRollingCorrection(isFinal, attempt = 0) {
    if (!deps.config.ROLLING_ASR_ENABLED) return null;
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
        });
      }
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
        await triggerRollingCorrection(true, 0);
      }
      if (!isFinal && correctionSucceeded && shouldDrainQueued && !rollingRetryRunning) {
        void triggerRollingCorrection(false);
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
      void retryFailedRollingWindows(false);
    }, delay);
  }

  async function retryFailedRollingWindows(isFinal) {
    if (rollingRetryRunning) return false;
    rollingRetryRunning = true;
    deps.beginMeetingAiJob(meetingId);
    let allResolved = true;
    try {
      while (failedRollingWindows.length) {
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
          });
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
    if (!allResolved && failedRollingWindows.some((window) => Number(window.attempt || 0) < deps.config.ROLLING_ASR_MAX_RETRIES)) scheduleFailedRollingRetry();
    if (allResolved && getRollingWindowPlan(false)) void triggerRollingCorrection(false);
    return allResolved;
  }

  function scheduleTranscriptFlush(reason = "endpoint", options = {}) {
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

  function getTranscriptFlushDelay(reason = "endpoint") {
    if (["stop", "client_close", "upstream_close", "max_text", "max_duration"].includes(reason)) {
      return Math.max(0, config.ASR_FINAL_STABILITY_DELAY_MS);
    }
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
    // SentenceEnd 是流式模型已经确认的句界。它必须立刻进入客户端时间轴，
    // 而不能只拼进一个“当前正在识别”的气泡，等到 45 秒文件校准才突然出现。
    // 这是仅用于展示的实时预览；真正持久化仍由后续 flush 完成。
    const previewStartMs = timedStartMs ?? pendingSpeechStartAudioMs ?? getTranscriptAudioOffsetMs();
    const previewEndMs = Math.max(previewStartMs + 1, timedEndMs ?? getTranscriptAudioOffsetMs());
    if (client.readyState === WebSocket.OPEN) {
      realtimeSegmentSequence += 1;
      safeSend({
        type: "transcript.realtime_segment",
        segment: {
          id: -realtimeSegmentSequence,
          time: deps.formatMeetingElapsedTime(previewStartMs / 1000),
          speaker: latestSpeakerResult?.speaker || "待识别",
          text: cleanedSegment,
          audioStartMs: Math.round(previewStartMs),
          audioEndMs: Math.round(previewEndMs),
          stabilityStatus: "draft",
          qualityStatus: "realtime",
          isRealtimePreview: true,
        },
      });
    }
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

  async function flushTranscriptBuffer(reason = "endpoint", options = {}) {
    if (transcriptFlushTimer) {
      clearTimeout(transcriptFlushTimer);
      transcriptFlushTimer = null;
      transcriptFlushReason = "";
    }
    let text = deps.normalizeTranscriptSegment(transcriptBuffer);
    const usingPartialFallback = !text && Boolean(options.fallbackToPartial);
    if (usingPartialFallback) text = deps.normalizeTranscriptSegment(latestPartial);
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
      transcriptBuffer = "";
      transcriptBufferEndAudioMs = 0;
      if (pendingSpeechStartAudioMs === null) {
        transcriptBufferStartedAt = "";
        transcriptBufferStartedAudioMs = 0;
      }
      latestPartial = "";
      return null;
    }
    // 最终落库前再次清理 filler
    text = deps.removeFillerWords(text);
    if (!text || deps.isFillerOnly(text)) {
      transcriptBuffer = "";
      transcriptBufferEndAudioMs = 0;
      if (pendingSpeechStartAudioMs === null) transcriptBufferStartedAt = "";
      latestPartial = "";
      return null;
    }
    const startedAt = transcriptBufferStartedAt || getTranscriptTimeLabel();
    // 0 是合法的会议起始时间，不能用 || 把它误判成“未设置”，否则首段
    // 会被错误地标到当前音频位置，后续文件 ASR 对齐会整体偏移。
    const audioStartMs = transcriptBufferStartedAt
      ? Number(transcriptBufferStartedAudioMs || 0)
      : getTranscriptAudioOffsetMs();
    const currentAudioChunks = speechAudioChunks;
    const quality = deps.analyzePcmQuality(currentAudioChunks);
    const measuredEndMs = getTranscriptAudioOffsetMs();
    const timedEndMs = Number(transcriptBufferEndAudioMs || 0);
    const audioEndMs = timedEndMs > 0
      ? Math.max(audioStartMs, timedEndMs)
      : Math.max(audioStartMs, audioStartMs + Math.max(0, Number(quality.durationMs || 0)), measuredEndMs);
    let hotwords = [];
    let glossaryEntries = [];
    try {
      glossaryEntries = deps.getMeetingGlossaryEntries(meetingId);
      hotwords = deps.uniqueStrings(glossaryEntries.flatMap((entry) => [entry.term, ...(entry.aliases || [])]).filter(Boolean)).slice(0, 100);
    } catch { /* 词库不可用时保留原文 */ }
    if (usingPartialFallback) {
      lastPartialFlushText = text;
      lastPartialFlushAudioStartMs = transcriptBufferStartedAt
        ? Number(transcriptBufferStartedAudioMs || 0)
        : getTranscriptAudioOffsetMs();
    } else {
      // 正常 flush（SentenceEnd 进 buffer）说明快照句子已终结，重置快照跟踪。
      lastPartialFlushText = "";
      lastPartialFlushAudioStartMs = 0;
    }
    transcriptBuffer = "";
    transcriptBufferStartedAt = "";
    transcriptBufferStartedAudioMs = 0;
    transcriptBufferEndAudioMs = 0;
    pendingSpeechStartAt = "";
    pendingSpeechStartAudioMs = null;
    latestPartial = "";
    speechAudioChunks = [];
    speechAudioBytes = 0;
    pendingAudioChunks = [];
    pendingAudioBytes = 0;
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "status", status: "correcting", reason }));
    let audioPath = "";
    let wav = null;
    try {
      ({ audioPath, wav } = deps.savePcmAsWav(currentAudioChunks, meetingId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[transcript] audio save failed meeting=${meetingId}: ${message}`);
    }

    // 会中草稿只做确定性的词库修正；稳定版本由滚动文件转写统一校准。
    let correctedText = deps.applyGlossaryAliasCorrections(text, glossaryEntries) || text;
    let speakerResult = latestSpeakerResult;

    // 逐句 LLM 纠错和说话人分离会与稳定校准重复。声纹仅低频采样，保留最近可靠说话人作草稿标注。
    const textCompact = text.replace(/\s/g, "");
    const shouldRunLiveCorrection = textCompact.length >= 10 && (!config.ROLLING_ASR_ENABLED || config.LIVE_DRAFT_LLM_CORRECTION);
    const shouldIdentifySpeaker = Boolean(wav?.length)
      && Number(quality.durationMs || 0) >= 1200
      && (!config.ROLLING_ASR_ENABLED || Date.now() - lastSpeakerIdentifyAt >= config.LIVE_SPEAKER_IDENTIFY_INTERVAL_MS);
    const shouldRunDiarization = !deps.config.ROLLING_ASR_ENABLED && textCompact.length >= 10;
    if (shouldIdentifySpeaker) lastSpeakerIdentifyAt = Date.now();

    const [correction, speaker, diarization] = await Promise.allSettled([
      shouldRunLiveCorrection ? deps.correctTranscriptText({ meetingId, text }) : Promise.resolve(correctedText),
      shouldIdentifySpeaker ? deps.identifySpeakerFromAudio({ meetingId, wav, audioPath }) : Promise.resolve(latestSpeakerResult),
      shouldRunDiarization ? deps.diarizeSpeakerSegments({ meetingId, wav, audioPath }) : Promise.resolve([]),
    ]);
    if (correction.status === "fulfilled") {
      correctedText = deps.normalizeTranscriptSegment(correction.value) || text;
    } else {
      const message = correction.reason instanceof Error ? correction.reason.message : String(correction.reason);
      console.error(`[transcript] correction failed meeting=${meetingId}: ${message}`);
    }
    if (speaker.status === "fulfilled") {
      speakerResult = speaker.value || latestSpeakerResult;
      if (speaker.value) latestSpeakerResult = speaker.value;
    } else {
      const message = speaker.reason instanceof Error ? speaker.reason.message : String(speaker.reason);
      console.error(`[transcript] speaker identify failed meeting=${meetingId}: ${message}`);
    }
    const diarizationSegments = diarization.status === "fulfilled" ? diarization.value || [] : [];
    if (diarization.status === "rejected") {
      const message = diarization.reason instanceof Error ? diarization.reason.message : String(diarization.reason);
      console.error(`[transcript] diarization failed meeting=${meetingId}: ${message}`);
    }

    const lineDrafts = await deps.buildTranscriptLineDrafts({
      meetingId,
      startedAt,
      text: correctedText,
      fallbackSpeaker: speakerResult,
      audioPath,
      wav,
      diarizationSegments,
      audioStartMs,
      audioEndMs,
    });
    const timelineLineDrafts = deps.normalizeTranscriptDraftTimeline(meetingId, lineDrafts, quality);
    const correctionApplied = deps.normalizeTranscriptSegment(correctedText) !== deps.normalizeTranscriptSegment(text);
    const correctionReason = correctionApplied
      ? (shouldRunLiveCorrection ? "glossary_or_llm" : "glossary")
      : "";
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
    for (const line of insertedLines) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "transcript.final", line }));
      if (line.stabilityStatus === "stable") deps.scheduleServerAutoAnalyze(meetingId, line.stableRevision);
    }
    return insertedLines.at(-1) || null;
  }

  function stopUpstream() {
    clearInterval(clientPingTimer);
    upstreamStopped = true;
    if (upstreamReconnectTimer) {
      clearTimeout(upstreamReconnectTimer);
      upstreamReconnectTimer = null;
    }
    if (silenceKeepaliveTimer) {
      clearInterval(silenceKeepaliveTimer);
      silenceKeepaliveTimer = null;
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
