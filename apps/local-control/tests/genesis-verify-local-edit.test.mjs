import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startScriptedModelServer } from "./helpers/scripted-model-server.mjs";

// The owner's one-command check must itself be trustworthy: it passes a model that really fixes the bug
// and fails one that only talks about it. Needs the CLI's dev dependencies (the Genesis CI job has them).
const atlasRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const buildable = existsSync(join(atlasRoot, "packages", "atlas-cli", "node_modules", "typescript"));
const skip = buildable || process.env.GENESIS_REQUIRE_FULL === "1" ? false : "packages/atlas-cli dependencies are not installed";

function run(baseUrl, home) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["scripts/local/verify-local-edit.mjs", "--model", "qwen2.5-coder:1.5b", "--base-url", baseUrl], {
      cwd: atlasRoot, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ATLAS_LOCAL_DATA_DIR: home },
    });
    let out = ""; child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { out += c; });
    child.on("close", (code) => resolveRun({ code, out }));
  });
}

test("verify-local-edit passes a model that really fixes the bug", { skip, timeout: 240_000 }, async (t) => {
  const model = await startScriptedModelServer(({ turn }) => turn === 0
    ? { edits: [{ path: "math.mjs", content: "export function add(a, b) {\n  return a + b;\n}\n" }], say: "Fixing add." }
    : { say: "add now returns the sum." });
  t.after(() => model.close());
  const { code, out } = await run(model.baseUrl.replace(/\/v1$/u, ""), process.env.TMPDIR || "/tmp");
  assert.equal(code, 0, out);
  assert.match(out, /PASS: the local model changed the file/u);
});

test("verify-local-edit fails a model that only talks about the fix, and a wrong edit", { skip, timeout: 240_000 }, async (t) => {
  const talker = await startScriptedModelServer(() => ({ say: "You should change a - b to a + b." }));
  t.after(() => talker.close());
  const talked = await run(talker.baseUrl.replace(/\/v1$/u, ""), process.env.TMPDIR || "/tmp");
  assert.equal(talked.code, 1, talked.out);
  assert.match(talked.out, /FAIL:/u);
  assert.match(talked.out, /No patch was produced/u);
  assert.match(talked.out, /original check fails/u);
  assert.match(talked.out, /hidden check fails/u);

  const wrong = await startScriptedModelServer(({ turn }) => turn === 0
    ? { edits: [{ path: "math.mjs", content: "export function add(a, b) {\n  return a * b;\n}\n" }] } : { say: "done" });
  t.after(() => wrong.close());
  const bad = await run(wrong.baseUrl.replace(/\/v1$/u, ""), process.env.TMPDIR || "/tmp");
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /original check fails/u);
});
