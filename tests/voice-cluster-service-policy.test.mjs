import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const moduleBase = existsSync(new URL("../modules/voice-cluster-service.mjs", import.meta.url))
  ? "../modules/"
  : "./";
const { shouldApplyVoiceClusterProposal } = await import(new URL(`${moduleBase}voice-cluster-service.mjs`, import.meta.url));

test("稀疏声纹的标签传播不覆盖已有滚动分离结果", () => {
  assert.equal(shouldApplyVoiceClusterProposal({
    speaker: "说话人 2",
    speakerSource: "rolling_diarization",
  }, {
    proposedSpeaker: "说话人 1",
    diagnostics: { propagatedFromLabel: "说话人 1" },
  }), false);
});

test("直接声纹证据仍可修正滚动分离结果", () => {
  assert.equal(shouldApplyVoiceClusterProposal({
    speaker: "说话人 2",
    speakerSource: "rolling_diarization",
  }, {
    proposedSpeaker: "说话人 1",
    diagnostics: { coverage: 0.9 },
  }), true);
});

test("标签传播可以补齐低置信来源", () => {
  assert.equal(shouldApplyVoiceClusterProposal({
    speaker: "待识别",
    speakerSource: "file_asr",
  }, {
    proposedSpeaker: "说话人 1",
    diagnostics: { propagatedFromLabel: "说话人 1" },
  }), true);
});
