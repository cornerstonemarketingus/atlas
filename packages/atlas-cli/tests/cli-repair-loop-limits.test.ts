import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const execute = promisify(execFile);

/**
 * Real boundary: the built CLI, a real repository whose own `npm run test`
 * is the check, and a local OpenAI-compatible server standing in for the
 * model. The first pass breaks the check; every repair edits something
 * unrelated, so the same failure survives. With five repair attempts
 * allowed, the loop must stop with no-progress after two.
 */
async function fixture(t: { after: (fn: () => Promise<void>) => void }, options: { delayFirstMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atlas-repair-loop-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "repair-loop-fixture", version: "1.0.0", private: true, scripts: { test: "node check.mjs" } }));
  await writeFile(join(root, "check.mjs"), [
    "import { existsSync } from 'node:fs';",
    "if (existsSync('broken.txt')) { console.error('broken.txt must not exist'); process.exit(1); }",
    "console.log('ok');",
  ].join("\n"));

  let calls = 0;
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(body);
    calls++;
    if (calls === 1 && options.delayFirstMs) await new Promise((resolve) => setTimeout(resolve, options.delayFirstMs));
    // Each agent pass is two model calls: propose a change, then finish.
    const agentPass = Math.ceil(calls / 2);
    const proposing = calls % 2 === 1;
    const edits = agentPass === 1
      ? [{ operation: "create", path: "broken.txt", content: "oops\n" }]
      : [{ operation: "create", path: `notes-${agentPass}.txt`, content: `attempt ${agentPass}\n` }];
    const message = proposing
      ? { content: null, tool_calls: [{ id: `edit-${calls}`, type: "function", function: { name: "repository.propose_change_set", arguments: JSON.stringify({ edits }) } }] }
      : { content: `Pass ${agentPass} done.` };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: `fixture-${calls}`, model: "fixture", choices: [{ message, finish_reason: proposing ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const run = async (extra: readonly string[]) => {
    const { stdout } = await execute(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "code", root, "Do the task", "--provider", "groq", "--model", "fixture", "--api-key-env", "ATLAS_TEST_KEY", "--base-url", `http://127.0.0.1:${address.port}/v1`, "--format", "json", ...extra],
      { timeout: 120_000, windowsHide: true, env: { ...process.env, ATLAS_TEST_KEY: "fixture-key", ATLAS_CODER_CONTEXT_WINDOW: "", ATLAS_CODER_MAX_OUTPUT_TOKENS: "" } });
    return JSON.parse(stdout);
  };
  return { run, requests, calls: () => calls };
}

test("actual coder CLI stops a repair loop that makes no progress before using every attempt", async (t) => {
  const { run, requests, calls: callCount } = await fixture(t);
  const result = await run(["--max-repair-attempts", "5"]);
  const calls = callCount();

  assert.equal(result.verification.status, "regressed");
  assert.equal(result.verification.stopReason, "no-progress");
  assert.equal(result.verification.attempts, 3, "one pass plus two repairs, not five");
  assert.equal(calls, 6, "no model call after the loop stopped");
  assert.equal(result.verification.loop.repairs, 2);
  assert.equal(result.verification.loop.sameFailure, 2);
  assert.equal(result.verification.loop.limits.maxRepairAttempts, 5);
  assert.equal(result.verification.loop.limits.maxTokens, 16_384, "spend is bounded by --token-budget's ledger");
  assert.equal(result.verification.loop.limits.maxWallMs, 6 * 60 * 60_000);
  assert.equal(result.verification.loop.tokensSpent, 60);
  assert.ok(result.verification.newFailures.some((failure: string) => /broken\.txt must not exist/u.test(failure)));
  // The repair passes were shown only what the change broke.
  assert.match(requests[2] ?? "", /broken\.txt must not exist/u);
});

test("actual coder CLI honours --max-repair-ms before starting a repair", async (t) => {
  const { run, calls } = await fixture(t, { delayFirstMs: 1_200 });
  const result = await run(["--max-repair-attempts", "5", "--max-repair-ms", "1000", "--max-same-failure", "3"]);
  assert.equal(result.verification.stopReason, "time-limit");
  assert.equal(result.verification.attempts, 1);
  assert.equal(calls(), 2, "no repair pass was started");
  assert.equal(result.verification.loop.limits.maxWallMs, 1_000);
  assert.equal(result.verification.loop.limits.maxSameFailure, 3);
});

test("actual coder CLI rejects out-of-range repair-loop limits", async () => {
  for (const args of [["--max-repair-ms", "5"], ["--max-same-failure", "0"]]) {
    await assert.rejects(
      execute(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "code", ".", "x", "--provider", "groq", "--model", "fixture", "--api-key-env", "ATLAS_TEST_KEY", ...args],
        { timeout: 30_000, windowsHide: true, env: { ...process.env, ATLAS_TEST_KEY: "fixture-key" } }),
      (error: { code?: number; stderr?: string }) => error.code === 2 && new RegExp(`${args[0]} must be an integer`, "u").test(error.stderr ?? ""),
    );
  }
});
