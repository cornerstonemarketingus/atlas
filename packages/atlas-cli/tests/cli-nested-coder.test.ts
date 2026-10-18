import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const execute = promisify(execFile);

test("actual coder CLI creates a website in missing directories and returns a change receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atlas-nested-coder-"));
  await writeFile(join(root, "README.md"), "Website fixture\n");
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume bounded fixture request */ }
    calls++;
    const message = calls === 1 ? { content: null, tool_calls: [{ id: "create-site", type: "function", function: { name: "repository.propose_change_set", arguments: JSON.stringify({ edits: [
      { operation: "create", path: "apps/web/services/wood-framing-mn/index.html", content: "<!doctype html><h1>Minnesota framing</h1>" },
      { operation: "create", path: "apps/web/services/wood-framing-mn/styles.css", content: "body { color: navy; }" },
    ] }) } }] } : { content: "Created the website files." };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "fixture-" + calls, model: "fixture", choices: [{ message, finish_reason: calls === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const { stdout } = await execute(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "code", root, "Create the website", "--provider", "groq", "--model", "fixture", "--api-key-env", "ATLAS_TEST_KEY", "--base-url", "http://127.0.0.1:" + address.port + "/v1", "--no-verify", "--format", "json"],
    { timeout: 30000, windowsHide: true, env: { ...process.env, ATLAS_TEST_KEY: "fixture-key", ATLAS_CODER_CONTEXT_WINDOW: "", ATLAS_CODER_MAX_OUTPUT_TOKENS: "" } });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "completed"); assert.equal(result.edits.length, 2); assert.equal(calls, 2);
  assert.match(await readFile(join(root, "apps/web/services/wood-framing-mn/index.html"), "utf8"), /Minnesota framing/);
  assert.equal(result.verification.status, "unverified");
});
