import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// 同一测试会被 sync-core 复制到消费端 server/；兼容核心仓库与消费端两种目录。
const moduleUrl = existsSync(new URL("../modules/tail-stabilization.mjs", import.meta.url))
  ? new URL("../modules/tail-stabilization.mjs", import.meta.url)
  : new URL("./tail-stabilization.mjs", import.meta.url);
const { fetchWithDeadline, recoverStaleTailStabilizations } = await import(moduleUrl);

test("文件 ASR 单次请求超时会失败，而不是永久悬挂", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  try {
    await assert.rejects(
      fetchWithDeadline("upload", "https://example.test/upload", {}, { deadline: Date.now() + 100, requestTimeoutMs: 15 }),
      /file ASR upload request timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("遗留尾段只收口草稿并解除状态", async () => {
  const calls = [];
  const recovered = await recoverStaleTailStabilizations({
    listStale: async () => [7],
    forceStabilize: async (id) => { calls.push(`force:${id}`); return 3; },
    markComplete: async (id) => { calls.push(`complete:${id}`); },
    now: () => Date.parse("2026-07-22T00:10:00.000Z"),
  });
  assert.deepEqual(calls, ["force:7", "complete:7"]);
  assert.deepEqual(recovered, [{ meetingId: 7, fallbackCount: 3 }]);
});
