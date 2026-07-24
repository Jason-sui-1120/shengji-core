import test from "node:test";
import assert from "node:assert/strict";
import { resolveRequestedAsrModel } from "./model-routing.mjs";

test("显式 ke-stream-asr 不得被生产默认模型静默替换", () => {
  assert.equal(resolveRequestedAsrModel("ke-stream-asr", "huoshanLM-realtime-asr"), "ke-stream-asr");
});

test("未指定模型时才使用生产默认模型", () => {
  assert.equal(resolveRequestedAsrModel("", "huoshanLM-realtime-asr"), "huoshanLM-realtime-asr");
});
