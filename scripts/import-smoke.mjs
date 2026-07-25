// core 模块 import 冒烟：每个模块必须可 import；纯函数 export 抽样调用不得抛 ReferenceError。
// 作为 core 发布门禁运行：node scripts/import-smoke.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesDir = path.join(rootDir, "modules");
const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith(".mjs")).sort();

let failures = 0;
for (const file of files) {
  try {
    await import(path.join(modulesDir, file));
    console.log(`ok   import ${file}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL import ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

// 纯函数抽样调用（捕获 ReferenceError/TypeError 级别的“未定义引用”）
const samples = [
  ["text-utils.mjs", "normalizeTranscriptSegment", ["你好， 世界"]],
  ["text-utils.mjs", "isFillerOnly", ["嗯"]],
  ["live-asr-helpers.mjs", "shouldFlushTranscriptBuffer", ["x".repeat(200)]],
  ["live-asr-helpers.mjs", "shouldWaitForMoreSpeech", ["我们今天讨论"]],
  ["live-asr-helpers.mjs", "looksSemanticallyIncomplete", ["因为"]],
  ["glossary-text.mjs", "applyGlossaryAliasCorrections", ["声迹系统", [{ term: "声纪", aliases: ["声迹"], weight: 80, enabled: true }]]],
  ["audio-utils.mjs", "wrapPcm16AsWav", [Buffer.alloc(320), 16000]],
  ["audio-utils.mjs", "getWavDurationSeconds", [null]],
  ["file-segments.mjs", "formatMeetingElapsedTime", [65]],
  ["rolling-window-plan.mjs", "buildRollingWindowPlan", [{ requestStartMs: 0, availableEndMs: 90_000, commitStartMs: 0, isFinal: false, windowMs: 45_000, baseLookbackMs: 15_000, maxLookbackMs: 120_000, rightContextMs: 15_000, maxForwardExtensionMs: 30_000, speechIntervals: [] }]],
  ["evidence-utils.mjs", "normalizeForTranscriptCompare", ["测试 ABC"]],
];
for (const [file, fn, args] of samples) {
  try {
    const mod = await import(path.join(modulesDir, file));
    if (typeof mod[fn] !== "function") throw new Error(`export ${fn} missing`);
    await mod[fn](...args);
    console.log(`ok   call ${file}#${fn}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL call ${file}#${fn}: ${error instanceof Error ? error.message : error}`);
  }
}

if (failures) {
  console.error(`\nimport-smoke FAILED: ${failures} 个问题`);
  process.exit(1);
}
console.log("\nimport-smoke 全部通过");
