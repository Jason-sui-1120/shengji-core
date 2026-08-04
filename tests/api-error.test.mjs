// api-error 契约测试：结构化错误
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { apiError, sendError, errors, normalizeError, ErrorCodes } from "./api-error.mjs";

describe("apiError", () => {
  test("构造标准结构", () => {
    const e = apiError("NOT_FOUND", "会议不存在", 404);
    assert.equal(e.error, "会议不存在");
    assert.equal(e.code, "NOT_FOUND");
    assert.equal(e.status, 404);
    assert.equal(e.details, undefined);
  });
  test("带 details", () => {
    const e = apiError("VALIDATION_FAILED", "参数错误", 400, { field: "meetingId" });
    assert.deepEqual(e.details, { field: "meetingId" });
  });
  test("默认值兜底", () => {
    const e = apiError();
    assert.equal(e.code, "INTERNAL_ERROR");
    assert.equal(e.status, 500);
  });
});

describe("sendError", () => {
  test("调用 sendJson 并传结构化错误", () => {
    let captured = null;
    const sendJson = (res, status, payload) => { captured = { status, payload }; };
    sendError({}, sendJson, "FORBIDDEN", "无权限", 403);
    assert.equal(captured.status, 403);
    assert.equal(captured.payload.code, "FORBIDDEN");
    assert.equal(captured.payload.error, "无权限");
  });
});

describe("errors 快捷构造", () => {
  test("notFound", () => {
    assert.deepEqual(errors.notFound("不存在"), { error: "不存在", code: "NOT_FOUND", status: 404 });
  });
  test("missingParam", () => {
    const e = errors.missingParam("meetingId");
    assert.equal(e.status, 400);
    assert.ok(e.error.includes("meetingId"));
  });
  test("forbidden 默认消息", () => {
    assert.equal(errors.forbidden().error, "无权限访问此资源");
  });
  test("unauthorized 默认消息", () => {
    assert.equal(errors.unauthorized().status, 401);
  });
});

describe("normalizeError", () => {
  test("已是结构化错误原样返回", () => {
    const input = { error: "x", code: "BAD_REQUEST", status: 400 };
    assert.deepEqual(normalizeError(input), input);
  });
  test("Error 实例转结构化", () => {
    const e = normalizeError(new Error("数据库连接失败"));
    assert.equal(e.error, "数据库连接失败");
    assert.equal(e.code, "INTERNAL_ERROR");
    assert.equal(e.status, 500);
  });
  test("字符串转结构化", () => {
    const e = normalizeError("出错了");
    assert.equal(e.error, "出错了");
  });
  test("自定义 fallback code", () => {
    const e = normalizeError(new Error("x"), ErrorCodes.VALIDATION_FAILED);
    assert.equal(e.code, "VALIDATION_FAILED");
    assert.equal(e.status, 400);
  });
  test("null/undefined 兜底", () => {
    assert.equal(normalizeError(null).error, "未知错误");
    assert.equal(normalizeError(undefined).error, "未知错误");
  });
});

describe("ErrorCodes 完整性", () => {
  test("包含所有标准码", () => {
    for (const code of ["BAD_REQUEST","UNAUTHORIZED","FORBIDDEN","NOT_FOUND","VALIDATION_FAILED","MISSING_PARAM","INTERNAL_ERROR","UPSTREAM_ERROR","AI_GATEWAY_ERROR","DATABASE_ERROR"]) {
      assert.ok(ErrorCodes[code], `缺少 ${code}`);
    }
  });
});
