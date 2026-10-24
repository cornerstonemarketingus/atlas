import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONTEXT_WINDOW, LEGACY_DEFAULT_MODEL, resolveLocalCoder } from "../src/agent/models/local-coder.mjs";
import { runIsolatedLocalCoder } from "../src/runner.mjs";
import { startScriptedModelServer } from "./helpers/scripted-model-server.mjs";

const plan = (coder) => ({ read: () => (coder ? { coder } : null) });

test("repository.coder model selection: request, env, model plan, then the legacy default", () => {
  // The model plan's 1.5B coder wins over the placeholder 7B the UI sends.
  const planned = resolveLocalCoder({ requested: LEGACY_DEFAULT_MODEL, modelPlan: plan({ tag: "qwen2.5-coder:1.5b", context: 8192 }), env: {} });
  assert.deepEqual([planned.model, planned.contextWindow, planned.source], ["qwen2.5-coder:1.5b", 8192, "model plan"]);
  // An env override beats the plan; a model named by the caller beats both.
  assert.equal(resolveLocalCoder({ requested: "", modelPlan: plan({ tag: "a:1b", context: 4096 }), env: { ATLAS_LOCAL_CODER_MODEL: "b:2b" } }).model, "b:2b");
  assert.equal(resolveLocalCoder({ requested: "c:3b", modelPlan: plan({ tag: "a:1b" }), env: { ATLAS_LOCAL_CODER_MODEL: "b:2b" } }).source, "request");
  // The plan's window applies only to the plan's own model.
  assert.equal(resolveLocalCoder({ requested: "c:3b", modelPlan: plan({ tag: "a:1b", context: 4096 }), env: {} }).contextWindow, DEFAULT_CONTEXT_WINDOW);
  // Nothing configured: the old default, unchanged.
  const none = resolveLocalCoder({ requested: LEGACY_DEFAULT_MODEL, modelPlan: plan(null), env: {} });
  assert.deepEqual([none.model, none.source], [LEGACY_DEFAULT_MODEL, "default"]);
  // Output is always smaller than the window.
  assert.ok(resolveLocalCoder({ env: { ATLAS_LOCAL_CODER_CONTEXT_WINDOW: "2048", ATLAS_LOCAL_CODER_MAX_OUTPUT_TOKENS: "4096" } }).maxOutputTokens < 2048);
});

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

test("the real isolated coder edits a file on the configured 1.5B model over Ollama's API and delivers a patch", { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-coder-"));
  const checkout = join(directory, "checkout");
  git(directory, "init", "--quiet", "checkout");
  git(checkout, "config", "user.email", "atlas@example.invalid");
  git(checkout, "config", "user.name", "Atlas");
  await writeFile(join(checkout, "answer.mjs"), "export const answer = 1;\n");
  await writeFile(join(checkout, "check.mjs"), 'import { answer } from "./answer.mjs"; if (answer !== 2) process.exit(1);\n');
  await writeFile(join(checkout, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node check.mjs" } }));
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "Initial commit");
  const model = await startScriptedModelServer(({ turn }) => turn === 0
    ? { edits: [{ path: "answer.mjs", content: "export const answer = 2;\n" }], say: "Updating answer.mjs." }
    : { say: "answer is now 2 and the check passes." });
  t.after(async () => {
    await model.close();
    spawnSync("git", ["worktree", "prune"], { cwd: checkout });
    await rm(directory, { recursive: true, force: true });
  });

  const result = await runIsolatedLocalCoder(
    // The UI's placeholder model; the plan's coder must win.
    { id: "ollama-edit", repository: checkout, objective: "Set answer to 2 in answer.mjs.", model: LEGACY_DEFAULT_MODEL },
    { dataDirectory: join(directory, "data"), modelPlan: plan({ tag: "qwen2.5-coder:1.5b", context: 8192 }), baseUrl: model.baseUrl.replace(/\/v1$/u, "") },
  );

  assert.equal(result.ok, true, result.message);
  assert.ok(model.requests.length >= 2, "the model was called, then given the tool result");
  for (const request of model.requests) {
    assert.equal(request.protocol, "ollama", "requests use the native Ollama provider, not a relabelled OpenAI client");
    assert.equal(request.model, "qwen2.5-coder:1.5b", "the configured model ran, not the 7B default");
    assert.equal(request.options.num_ctx, 8192, "the declared context window is sent with every request");
    assert.ok(request.options.num_predict < 8192);
  }
  // Real file modification, in the worktree only.
  assert.equal(readFileSync(join(result.worktree, "answer.mjs"), "utf8"), "export const answer = 2;\n");
  assert.equal(readFileSync(join(checkout, "answer.mjs"), "utf8"), "export const answer = 1;\n");
  assert.equal(git(checkout, "status", "--porcelain").trim(), "");
  // Patch delivery: a portable patch that applies to a pristine clone.
  assert.ok(result.patch && existsSync(result.patch));
  const patch = readFileSync(result.patch, "utf8");
  assert.match(patch, /-export const answer = 1;/u);
  assert.match(patch, /\+export const answer = 2;/u);
  git(checkout, "apply", "--check", result.patch);
});
