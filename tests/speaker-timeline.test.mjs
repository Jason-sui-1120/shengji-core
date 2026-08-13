import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

// 这份测试同时复制到两端的 server/ 目录运行；core 自身模块在 ../modules/。
const moduleUrl = existsSync(new URL("../modules/speaker-timeline.mjs", import.meta.url))
  ? new URL("../modules/speaker-timeline.mjs", import.meta.url)
  : new URL("./speaker-timeline.mjs", import.meta.url);
const {
  assignSpeakersByAbsoluteOverlap,
  buildAbsoluteSpeakerSegments,
} = await import(moduleUrl);
const speakersModuleUrl = existsSync(new URL("../modules/speakers.mjs", import.meta.url))
  ? new URL("../modules/speakers.mjs", import.meta.url)
  : new URL("./speakers.mjs", import.meta.url);
const { normalizeDiarizationSegments } = await import(speakersModuleUrl);
const speakerCoreModuleUrl = existsSync(new URL("../modules/speaker-core.mjs", import.meta.url))
  ? new URL("../modules/speaker-core.mjs", import.meta.url)
  : new URL("./speaker-core.mjs", import.meta.url);
const { resolveSpeakerPublicBaseUrl } = await import(speakerCoreModuleUrl);
const speakerGatewayModuleUrl = existsSync(new URL("../modules/speaker-gateway.mjs", import.meta.url))
  ? new URL("../modules/speaker-gateway.mjs", import.meta.url)
  : new URL("./speaker-gateway.mjs", import.meta.url);
const {
  buildAitAuthorizationHeaders,
  executeDirectSpeakerDiarization,
} = await import(speakerGatewayModuleUrl);
const audioSignatureModuleUrl = existsSync(new URL("../modules/audio-access-signature.mjs", import.meta.url))
  ? new URL("../modules/audio-access-signature.mjs", import.meta.url)
  : new URL("./audio-access-signature.mjs", import.meta.url);
const {
  createRollingAudioAccessQuery,
  verifyRollingAudioAccessQuery,
} = await import(audioSignatureModuleUrl);

test("滚动音频签名只允许当前会议、当前文件且会过期", () => {
  const secret = "test-only-secret";
  const fileName = "meeting-77-rolling-1234-abcd.wav";
  const now = 1_000_000;
  const access = createRollingAudioAccessQuery({ secret, meetingId: 77, fileName, now });
  assert.ok(access?.signature);
  assert.equal(verifyRollingAudioAccessQuery({ secret, meetingId: 77, fileName, now, ...access }), true);
  assert.equal(verifyRollingAudioAccessQuery({ secret, meetingId: 78, fileName, now, ...access }), false);
  assert.equal(verifyRollingAudioAccessQuery({ secret, meetingId: 77, fileName: "meeting-77-rolling-other.wav", now, ...access }), false);
  assert.equal(verifyRollingAudioAccessQuery({ secret, meetingId: 77, fileName, now: access.expiresAt + 1, ...access }), false);
});

test("说话人回源域名未单独配置时复用应用 PUBLIC_BASE_URL", () => {
  assert.equal(resolveSpeakerPublicBaseUrl("", "https://voice.example.com/"), "https://voice.example.com");
  assert.equal(resolveSpeakerPublicBaseUrl("https://audio.example.com/", "https://voice.example.com"), "https://audio.example.com");
});

test("说话人直连鉴权使用统一配置值而不是绕过配置层读取进程变量", () => {
  assert.deepEqual(buildAitAuthorizationHeaders("configured-key"), {
    authorization: "Bearer configured-key",
  });
  assert.deepEqual(buildAitAuthorizationHeaders(""), {});
});

test("说话人回源失败时上传同一段 WAV 到 AIT 临时文件服务后重试", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/audio/speaker/diarization")) {
      const body = JSON.parse(String(init.body || "{}"));
      assert.equal("audioBase64" in body, false);
      if (body.url === "https://voice.example.com/unreachable.wav") {
        return new Response(JSON.stringify({ error: "audio URL download failed" }), { status: 400 });
      }
      assert.equal(body.url, "https://files.example.com/temp.wav");
      return new Response(JSON.stringify({ segments: [{ speaker: 0, start: 0, end: 2 }] }), { status: 200 });
    }
    if (String(url).endsWith("/files")) {
      assert.ok(init.body instanceof FormData);
      return new Response(JSON.stringify({ id: "file-1" }), { status: 200 });
    }
    if (String(url).endsWith("/files/file-1/url")) {
      return new Response(JSON.stringify({ url: "https://files.example.com/temp.wav" }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await executeDirectSpeakerDiarization({
    model: "ke-campplus-16k-common-advanced",
    url: "https://voice.example.com/unreachable.wav",
    audioBase64: Buffer.from("wav-bytes").toString("base64"),
  }, {
    apiKey: "configured-key",
    apiBase: "https://ait.example.com/v1",
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(calls.filter((call) => call.url.endsWith("/audio/speaker/diarization")).length, 2);
});

test("模型推理错误不重复上传同一段音频", async () => {
  const calls = [];
  const result = await executeDirectSpeakerDiarization({
    model: "ke-campplus-16k-common-advanced",
    url: "https://voice.example.com/valid.wav",
    audioBase64: Buffer.from("wav-bytes").toString("base64"),
  }, {
    apiKey: "configured-key",
    apiBase: "https://ait.example.com/v1",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: "ARPACK error -9: Starting vector is zero" }), { status: 400 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.deepEqual(calls, ["https://ait.example.com/v1/audio/speaker/diarization"]);
});

test("0 基分离标签不能把 speaker_0 与 speaker_1 合并成同一人", () => {
  const result = normalizeDiarizationSegments({
    segments: [
      { speaker: "speaker_0", start: 0, end: 2 },
      { speaker: "speaker_1", start: 2, end: 4 },
      { speaker: "speaker_0", start: 4, end: 6 },
    ],
  }, 77, 6);
  assert.deepEqual(result.map((segment) => segment.speaker), ["说话人 1", "说话人 2", "说话人 1"]);
});

test("窗口相对时间按请求起点换算为会议绝对时间", () => {
  const result = buildAbsoluteSpeakerSegments([
    { speaker: "speaker_1", start: 8.5, end: 12.25 },
  ], {
    windowStartMs: 45_000,
    centerStartMs: 53_000,
    centerEndMs: 90_000,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].absoluteStartMs, 53_500);
  assert.equal(result[0].absoluteEndMs, 57_250);
});

test("前后上下文外的说话人片段不进入中心窗口", () => {
  const result = buildAbsoluteSpeakerSegments([
    { speaker: "speaker_1", start: 0, end: 7.9 },
    { speaker: "speaker_2", start: 8, end: 10 },
    { speaker: "speaker_3", start: 53, end: 55 },
  ], {
    windowStartMs: 45_000,
    centerStartMs: 53_000,
    centerEndMs: 98_000,
  });
  assert.deepEqual(result.map((item) => item.speaker), ["speaker_2"]);
});

test("稳定行选择绝对时间重叠最大的会议级说话人", () => {
  const rows = [{ id: 1, audioStartMs: 10_000, audioEndMs: 14_000, speaker: "待识别", speakerSource: "file_asr" }];
  const segments = [
    { speaker: "speaker_1", absoluteStartMs: 9_000, absoluteEndMs: 11_000 },
    { speaker: "speaker_2", absoluteStartMs: 11_000, absoluteEndMs: 14_000 },
  ];
  const mapping = new Map([
    ["speaker_1", { speaker: "说话人 1", confidence: 70 }],
    ["speaker_2", { speaker: "说话人 2", confidence: 82 }],
  ]);
  const assignments = assignSpeakersByAbsoluteOverlap(rows, segments, mapping);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].winner.speaker, "说话人 2");
  assert.equal(assignments[0].overlapMs, 3_000);
});

test("人工编辑和人工说话人不会被自动回填覆盖", () => {
  const rows = [
    { id: 1, audioStartMs: 0, audioEndMs: 2_000, userEdited: 1, speakerSource: "file_asr" },
    { id: 2, audioStartMs: 2_000, audioEndMs: 4_000, userEdited: 0, speakerSource: "manual" },
  ];
  const segments = [{ speaker: "speaker_1", absoluteStartMs: 0, absoluteEndMs: 4_000 }];
  const mapping = new Map([["speaker_1", { speaker: "说话人 1", confidence: 70 }]]);
  assert.deepEqual(assignSpeakersByAbsoluteOverlap(rows, segments, mapping), []);
});

test("未映射到会议级声纹的窗口标签保持待识别", () => {
  const rows = [{ id: 1, audioStartMs: 0, audioEndMs: 2_000, speakerSource: "file_asr" }];
  const segments = [{ speaker: "speaker_9", absoluteStartMs: 0, absoluteEndMs: 2_000 }];
  assert.deepEqual(assignSpeakersByAbsoluteOverlap(rows, segments, new Map()), []);
});
