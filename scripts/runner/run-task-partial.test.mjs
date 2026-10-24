import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const built = existsSync(join(root, "packages/atlas-cli/dist/src/cli.js"));
const git = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };

// The hosted runner against a scripted Ollama: one real edit lands, then the model repeats a failing
// call. The run must stop early as blocked, keep the edit as a patch, and never claim completion.
test("a hosted coder run that stops after real edits keeps them as partial.patch and reports blocked", { skip: !built && "atlas-cli is not built", timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-partial-"));
  const target = join(dir, "target");
  const out = join(dir, "out");
  git(dir, "init", "--quiet", "target");
  git(target, "config", "user.email", "t@example.invalid");
  git(target, "config", "user.name", "T");
  await writeFile(join(target, "note.txt"), "old\n");
  git(target, "add", "-A");
  git(target, "commit", "--quiet", "-m", "init");
  const seen = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    seen.push({ url: request.url, body: text ? JSON.parse(text) : null });
    const n = seen.length;
    const call = n === 1
      ? { name: "repository.propose_change_set", arguments: { edits: [{ operation: "update", path: "note.txt", content: "new\n" }] } }
      : { name: "repository.read_source", arguments: { path: "missing.txt" } };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ model: "qwen2.5-coder:1.5b", message: { role: "assistant", content: "", tool_calls: [{ function: call }] }, done: true, done_reason: "stop", prompt_eval_count: 500, eval_count: 20 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });

  const child = spawn(process.execPath, ["scripts/runner/run-task.mjs"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: dir, ATLAS_OUTPUT_DIR: out, ATLAS_REPOSITORY_ROOT: target, ATLAS_TASK_ID: "task-partial", ATLAS_MODE: "coder", ATLAS_BRANCH: "main",
      ATLAS_OBJECTIVE: "Change note.txt", ATLAS_CODER_PROVIDER: "ollama", ATLAS_CODER_MODEL: "qwen2.5-coder:1.5b",
      ATLAS_CODER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, ATLAS_CODER_CONTEXT_WINDOW: "8192", ATLAS_CODER_MAX_OUTPUT_TOKENS: "512", ATLAS_MAX_TURNS: "12",
      // Paid keys that must never receive an Ollama-routed prompt.
      OPENAI_API_KEY: "paid-key-must-not-be-used", GROQ_API_KEY: "groq-key-must-not-be-used",
    },
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; }); child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 1, stderr);
  assert.match(stdout, /Coder route: ollama\/qwen2\.5-coder:1\.5b; configured fallbacks: ; cost classes: ollama=local\s*$/mu, "no automatic fallbacks, paid or otherwise");
  assert.ok(seen.every((r) => r.url === "/api/chat"), "every request went to the configured Ollama only");
  assert.equal(seen.length, 4, "one edit, then three identical failures, then stop: no turns wasted");
  const status = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
  assert.equal(status.status, "blocked");
  assert.match(status.message, /Repeated tool failure: repository\.read_source failed 3 times/u);
  assert.match(status.message, /Partial work: 1 file\(s\) changed, saved as partial\.patch/u);
  assert.equal(status.partial.files, 1);
  const patch = readFileSync(join(out, "partial.patch"), "utf8");
  assert.match(patch, /-old/u);
  assert.match(patch, /\+new/u);
  const codeJson = JSON.parse(readFileSync(join(out, "code.json"), "utf8"));
  assert.equal(codeJson.status, "blocked");
  assert.deepEqual(codeJson.edits.map((e) => e.path), ["note.txt"]);
  assert.ok(!existsSync(join(out, "pull-request.json")), "no pull request is prepared for unfinished work");
});
