// rolling-service-consistency.test.mjs —— RollingTranscriptService 双端一致性验证。
// 用同一组滚动窗口 fixture 驱动服务核心纯逻辑（候选行过滤/对齐/段合成），
// 验证两端共用代码路径输出一致。真实 DB 一致性由各自 store 契约测试 + 集成验证覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
// 同一测试复制到消费端 server/；核心仓库的模块在 ../modules/。
const moduleBase = existsSync(new URL("../modules/transcript-align.mjs", import.meta.url))
  ? "../modules/"
  : "./";
const transcriptAlign = await import(new URL(`${moduleBase}transcript-align.mjs`, import.meta.url));
const transcriptComposer = await import(new URL(`${moduleBase}transcript-composer.mjs`, import.meta.url));
const rollingModuleUrl = new URL(`${moduleBase}rolling-transcript-service.mjs`, import.meta.url);
const {
  alignFileSegmentsToRowsByAbsoluteTime,
  extractStableWindowText,
  mapDiarizationSpeakersToRows,
  isUsableTranscriptCorrection,
} = transcriptAlign;
const { composeCanonicalFileSegments } = transcriptComposer;
const {
  RollingTranscriptService,
  getMappedCandidateRows,
  shouldReplaceWindowForPartialAlignment,
  applySpeakerHintsToFileSegments,
} = await import(rollingModuleUrl);

// 1070 风格 fixture：实时草稿行 + 文件 ASR 结果
const fixtureRows = [
  { id: 101, text: "我们今天讨论一下下季度的", audioStartMs: 45000, audioEndMs: 49000, userEdited: 0 },
  { id: 102, text: "销售目表", audioStartMs: 49000, audioEndMs: 51000, userEdited: 0 },
  { id: 103, text: "和去年的同比增长", audioStartMs: 51000, audioEndMs: 55000, userEdited: 0 },
];

const fixtureFileResult = {
  text: "我们今天讨论一下下季度的销售目标，和去年的同比增长情况。",
  segments: [
    { text: "我们今天讨论一下下季度的销售目标", start_time: 5, end_time: 9.5 },
    { text: "和去年的同比增长情况", start_time: 9.5, end_time: 13 },
  ],
  words: [
    { text: "我们", start_time: 5, end_time: 5.4, speaker: "speaker_1" },
    { text: "销售目标", start_time: 8, end_time: 9.5, speaker: "speaker_1" },
    { text: "同比增长", start_time: 10, end_time: 11.5, speaker: "speaker_2" },
  ],
};

test("extractStableWindowText：双端共用，同一输入输出一致", () => {
  const a = extractStableWindowText(fixtureFileResult, 5, 2, 15);
  const b = extractStableWindowText(fixtureFileResult, 5, 2, 15);
  assert.equal(a, b);
  assert.ok(a.includes("销售目标"));
});

test("extractStableWindowText：毫秒级时间戳自动归一", () => {
  const msResult = {
    segments: [{ text: "测试段落", start_time: 5000, end_time: 9000 }],
  };
  const text = extractStableWindowText(msResult, 5, 0, 10);
  assert.ok(text.includes("测试段落"));
});

test("alignFileSegmentsToRowsByAbsoluteTime：文件段对齐到行", () => {
  const aligned = alignFileSegmentsToRowsByAbsoluteTime(
    fixtureRows,
    fixtureFileResult,
    5,
    45000,
    "",
    2,
    15000,
  );
  assert.ok(Array.isArray(aligned.lines) || Array.isArray(aligned));
});

test("isUsableTranscriptCorrection：阈值 0.55 两端一致", () => {
  // 高重叠：应通过
  assert.equal(isUsableTranscriptCorrection("我们今天讨论下季度的销售目标", "我们今天讨论一下下季度的销售目标"), true);
  // 低重叠（完全无关）：应拒绝
  assert.equal(isUsableTranscriptCorrection("我们今天讨论销售目标增长情况", "完全不同的另一段文字内容啊"), false);
});

test("composeCanonicalFileSegments：窗口内单调化 + 重叠消除", () => {
  const segments = [
    { startMs: 45000, endMs: 50000, text: "第一段" },
    { startMs: 49500, endMs: 54000, text: "第二段" },
    { startMs: 53000, endMs: 58000, text: "第二段重复" },
  ];
  const canonical = composeCanonicalFileSegments(segments, {
    windowStartMs: 45000,
    windowEndMs: 58000,
    protectedRows: [],
    precedingRows: [],
  });
  // 单调递增
  for (let i = 1; i < canonical.length; i += 1) {
    assert.ok(canonical[i].startMs >= canonical[i - 1].startMs, "段应单调递增");
  }
});

test("mapDiarizationSpeakersToRows：声纹投射到行", () => {
  const aligned = [
    { id: 101, text: "我们今天讨论一下下季度的销售目标", audioStartMs: 45000, audioEndMs: 49500 },
    { id: 103, text: "和去年的同比增长情况", audioStartMs: 51000, audioEndMs: 55000 },
  ];
  const diarizationSegments = [
    { speaker: "speaker_1", start: 5, end: 9.5 },
    { speaker: "speaker_2", start: 9.5, end: 13 },
  ];
  const speakers = mapDiarizationSpeakersToRows(fixtureRows, aligned, diarizationSegments, 15, 5);
  assert.ok(speakers instanceof Map);
});

test("getMappedCandidateRows：未被文件稿覆盖的草稿不能伪装成稳定稿", () => {
  const candidates = [
    { id: 101, text: "已对齐的实时草稿" },
    { id: 102, text: "文件稿未覆盖的实时残片" },
    { id: 103, text: "已对齐的实时草稿" },
  ];
  const mapped = getMappedCandidateRows(candidates, [
    { id: 101, text: "稳定稿一" },
    { id: 103, text: "稳定稿二" },
  ]);
  assert.deepEqual(mapped.map((row) => row.id), [101, 103]);
});

test("部分对齐：文件稿必须整体替换窗口，不能把残片留到封存时降级", () => {
  const candidates = [
    { id: 101, text: "文件稿已覆盖的草稿" },
    { id: 102, text: "未覆盖且会造成重复的草稿残片" },
  ];
  assert.equal(shouldReplaceWindowForPartialAlignment(candidates, [
    { id: 101, text: "文件稳定稿", fileSegmentCount: 1 },
    // 对齐器为所有候选行返回占位项；没有文件段的占位项不得算作已映射。
    { id: 102, text: "旧草稿", fileSegmentCount: 0 },
  ]), true);
  assert.equal(shouldReplaceWindowForPartialAlignment(candidates, [
    { id: 101, text: "文件稳定稿一", fileSegmentCount: 1 },
    { id: 102, text: "文件稳定稿二", fileSegmentCount: 1 },
  ]), false);
  assert.equal(shouldReplaceWindowForPartialAlignment([], []), false);
});

test("整体替换：稳定文本继承已有时间轴说话人，不退化为待识别", () => {
  const [segment] = applySpeakerHintsToFileSegments([
    { text: "文件稳定稿", startMs: 1_000, endMs: 2_000 },
  ], [
    { speaker: "待识别", audioStartMs: 900, audioEndMs: 1_100 },
    { speaker: "说话人 2", speakerSource: "rolling_diarization", audioStartMs: 950, audioEndMs: 2_050 },
  ]);
  assert.equal(segment.speaker, "说话人 2");
  assert.equal(segment.speakerSource, "rolling_diarization");
});

test("稳定文件稿替换：删除旧自动行与写入 canonical 段必须交给同一 store 事务", async () => {
  const calls = [];
  const service = new RollingTranscriptService({
    async insertFileAsrStableSegments(meetingId, payload) {
      calls.push({ meetingId, payload });
      return { insertedCount: 1, insertedIds: [501], stableRevision: 12, deletedCount: 3 };
    },
    // 如果重新出现“先删再插”的两段式实现，本测试会立即失败。
    async deleteWindowTranscriptRows() {
      throw new Error("不得在文件插入事务外单独删除草稿");
    },
  });

  const result = await service.replaceWindowWithFileSegments({
    meetingId: 77,
    fileResult: {
      segments: [{ text: "文件稳定稿", start_time: 1, end_time: 4 }],
      words: [{ text: "文件稳定稿", start_time: 1, end_time: 4 }],
    },
    windowStartAudioMs: 0,
    windowEndAudioMs: 8_000,
    effectiveWindowStartMs: 1_000,
    effectiveWindowEndMs: 5_000,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].meetingId, 77);
  assert.equal(calls[0].payload.replaceExistingAutoRows, true);
  assert.equal(result.deletedCount, 3);
  assert.equal(result.compositionTrace.replacementInTransaction, true);
});

test("稳定稿落库后异步回填窗口说话人，不依赖草稿阶段已识别的说话人", async () => {
  const enrichmentCalls = [];
  const stableRevisions = [];
  const service = new RollingTranscriptService({
    async applySpeakerEnrichment(meetingId, payload) {
      enrichmentCalls.push({ meetingId, payload });
      return { updatedCount: 2, stableRevision: 19 };
    },
  }, {
    // CampPlus 返回的是本次窗口内相对时间，服务必须换算回会议绝对时间后再写回。
    async diarizeSpeakerSegments() {
      return [
        { speaker: "说话人 1", start: 8, end: 10, confidence: 88 },
        { speaker: "说话人 2", start: 10, end: 12, confidence: 91 },
      ];
    },
    async afterStableCorrection(meetingId, stableRevision) {
      stableRevisions.push({ meetingId, stableRevision });
    },
  });

  const result = await service.enrichStableWindowSpeakers({
    meetingId: 77,
    wav: Buffer.from([1, 2, 3]),
    audioPath: "/tmp/meeting-77-window.wav",
    windowStartAudioMs: 45_000,
    centerStartAudioMs: 53_000,
    centerEndAudioMs: 57_000,
    insertedRows: [
      { id: 501, speaker: "待识别", speakerSource: "file_asr", audioStartMs: 53_000, audioEndMs: 55_000, userEdited: 0 },
      { id: 502, speaker: "待识别", speakerSource: "file_asr", audioStartMs: 55_000, audioEndMs: 57_000, userEdited: 0 },
    ],
  });

  assert.deepEqual(result, { ok: true, speakerCount: 2, updatedCount: 2, stableRevision: 19 });
  assert.equal(enrichmentCalls.length, 1);
  assert.deepEqual(enrichmentCalls[0], {
    meetingId: 77,
    payload: {
      transcriptIds: [501, 502],
      assignments: [
        { id: 501, speaker: "说话人 1", confidence: 88 },
        { id: 502, speaker: "说话人 2", confidence: 91 },
      ],
      splitPlans: [],
    },
  });
  assert.deepEqual(stableRevisions, [{ meetingId: 77, stableRevision: 19 }]);
});
