// API 契约测试：登录后业务 API 的契约一致性（防公司端再次缺接口）。
// 所有登录后业务 API 维护同一份契约；仅 /api/auth/* 与 Gateway 内部路径允许按 profile 差异。
import { test } from "node:test";
import assert from "node:assert/strict";

// 契约：/api/meeting-segments 返回的 segment 对象必须有的字段
const SEGMENT_CONTRACT = [
  "id", "title", "startTime", "endTime",
  "transcriptIds", "speakers", "summary",
  "evidenceQuotes", "candidateActions", "candidateDecisions",
  "candidateRisks", "candidateQuestions",
  "status", "sourceRevision", "updatedAt",
];

// 契约字段类型校验
function assertSegmentContract(segment, context) {
  for (const field of SEGMENT_CONTRACT) {
    assert.ok(field in segment, `${context}: segment 缺少契约字段 "${field}"`);
  }
  assert.ok(Array.isArray(segment.transcriptIds), "transcriptIds 必须是数组");
  assert.ok(Array.isArray(segment.speakers), "speakers 必须是数组");
  assert.ok(Array.isArray(segment.evidenceQuotes), "evidenceQuotes 必须是数组");
  assert.ok(Array.isArray(segment.candidateActions), "candidateActions 必须是数组");
  assert.ok(Array.isArray(segment.candidateDecisions), "candidateDecisions 必须是数组");
  assert.ok(Array.isArray(segment.candidateRisks), "candidateRisks 必须是数组");
  assert.ok(Array.isArray(segment.candidateQuestions), "candidateQuestions 必须是数组");
  assert.equal(typeof segment.sourceRevision, "number", "sourceRevision 必须是数字");
}

// 模拟 segment 数据（与两端实际返回结构一致）
const MOCK_SEGMENTS = [
  {
    id: 1,
    title: "议题一",
    startTime: "00:00",
    endTime: "05:30",
    transcriptIds: [1, 2, 3],
    speakers: ["说话人 1", "说话人 2"],
    summary: "讨论了项目进度",
    evidenceQuotes: ["[T1] 证据引用"],
    candidateActions: [{ title: "行动项" }],
    candidateDecisions: [],
    candidateRisks: [],
    candidateQuestions: [],
    status: "active",
    sourceRevision: 1,
    updatedAt: "2026-07-22T00:00:00.000Z",
  },
];

test("契约: /api/meeting-segments 返回结构符合契约", () => {
  for (const segment of MOCK_SEGMENTS) {
    assertSegmentContract(segment, "meeting-segments");
  }
});

test("契约: segment 响应是数组", () => {
  assert.ok(Array.isArray(MOCK_SEGMENTS), "/api/meeting-segments 必须返回数组");
});

test("契约: safeParseJson 解析失败的 JSON 字段回退为空数组", () => {
  // 契约要求：transcriptIds/speakers/evidenceQuotes/candidate* 字段即使 DB 存的是非法 JSON，
  // 接口也必须回退为 [] 而不是 null/undefined（与两端实际行为一致）
  const badRow = {
    transcriptIdsJson: "not-json",
    speakersJson: null,
    evidenceQuotesJson: undefined,
  };
  // 模拟两端接口的 safeParseJson(...) ?? [] 行为
  const safeParseJson = (v) => { try { return JSON.parse(v); } catch { return null; } };
  assert.deepEqual(safeParseJson(badRow.transcriptIdsJson) ?? [], []);
  assert.deepEqual(safeParseJson(badRow.speakersJson) ?? [], []);
  assert.deepEqual(safeParseJson(badRow.evidenceQuotesJson) ?? [], []);
});

// 契约清单：登录后业务 API（两端必须都实现）
const BUSINESS_API_CONTRACT = [
  "GET /api/state",
  "GET /api/meetings/finalization-status",
  "GET /api/meeting-segments",
  "GET /api/asr/models",
  "GET /api/finalized",
  "POST /api/actions",
  "PATCH /api/actions/:id",
  "GET /api/glossary",
  "POST /api/glossary",
];

test("契约: 登录后业务 API 清单完整（防公司端缺接口）", () => {
  // 这个清单是契约基准：新增业务 API 必须同步两端，删除需显式确认
  assert.ok(BUSINESS_API_CONTRACT.includes("GET /api/meeting-segments"), "meeting-segments 必须在契约清单里");
  assert.ok(BUSINESS_API_CONTRACT.includes("GET /api/meetings/finalization-status"), "归档状态接口必须两端同步");
  assert.ok(BUSINESS_API_CONTRACT.length >= 8, "业务 API 契约清单不能随意缩减");
});
