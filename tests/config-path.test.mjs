import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

test("构建产物可读取部署根目录挂载的 config.json", async () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "shengji-config-path-"));
  const distServer = path.join(projectRoot, "dist", "server");
  const originalSource = process.env.SESSION_SOURCE;
  const originalSignature = process.env.SESSION_SIGNATURE;
  try {
    mkdirSync(distServer, { recursive: true });
    copyFileSync(path.join(serverDir, "config.mjs"), path.join(distServer, "config.mjs"));
    copyFileSync(path.join(serverDir, "env.mjs"), path.join(distServer, "env.mjs"));
    writeFileSync(path.join(projectRoot, "config.json"), JSON.stringify({
      SESSION_SOURCE: "compat-source",
      SESSION_SIGNATURE: "compat-signature",
    }));
    delete process.env.SESSION_SOURCE;
    delete process.env.SESSION_SIGNATURE;

    const config = await import(`${pathToFileURL(path.join(distServer, "config.mjs")).href}?test=${Date.now()}`);
    assert.equal(config.SESSION_SOURCE, "compat-source");
    assert.equal(config.SESSION_SIGNATURE, "compat-signature");
  } finally {
    if (originalSource === undefined) delete process.env.SESSION_SOURCE;
    else process.env.SESSION_SOURCE = originalSource;
    if (originalSignature === undefined) delete process.env.SESSION_SIGNATURE;
    else process.env.SESSION_SIGNATURE = originalSignature;
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
