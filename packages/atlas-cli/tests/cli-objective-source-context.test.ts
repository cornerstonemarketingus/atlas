import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const run = promisify(execFile);

for (const rejectFirst of [false, true]) {
test(`real coder fixes the named test through the CLI; provider rejects first call: ${rejectFirst}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "atlas-cli-objective-"));
  const secret = "ghp_0123456789abcdefghijABCDEFGHIJ0123";
  await writeFile(join(root, "answer.mjs"), "export const answer = 1;\n");
  await writeFile(join(root, "answer.test.mjs"), `// FIRST_REQUEST_REQUIREMENT ${secret}\nimport {answer} from './answer.mjs';import assert from 'node:assert/strict';assert.equal(answer,2);\n`);
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    requests.push(body);
    if (rejectFirst && requests.length === 1) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "tool_use_failed", failed_generation: "PRIVATE_REJECTED_GENERATION" } }));
      return;
    }
    const isEdit = requests.length === (rejectFirst ? 2 : 1);
    const message = isEdit ? { tool_calls: [{ id: "fix", type: "function", function: { name: "repository.propose_change_set",
      arguments: JSON.stringify({ edits: [{ operation: "update", path: "answer.mjs", content: "export const answer = 2;\n" }] }) } }] }
      : { content: "Updated answer.mjs to satisfy the test." };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: `r${requests.length}`, model: "fixture", choices: [{ message, finish_reason: isEdit ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const { stdout } = await run(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "code", root, "Fix answer.mjs so answer.test.mjs passes", "--provider", "groq", "--model", "fixture",
    "--base-url", `http://127.0.0.1:${address.port}/v1`, "--api-key-env", "ATLAS_TEST_KEY", "--no-verify", "--format", "json"],
  { timeout: 30000, windowsHide: true, env: { ...process.env, ATLAS_TEST_KEY: "fixture", ATLAS_CODER_CONTEXT_WINDOW: "", ATLAS_CODER_MAX_OUTPUT_TOKENS: "" } });
  assert.match(requests[0] ?? "", /FIRST_REQUEST_REQUIREMENT/u);
  assert.ok(requests.every(body => !body.includes(secret)));
  assert.ok(requests.every(body => !body.includes("PRIVATE_REJECTED_GENERATION")));
  assert.equal(requests.length, rejectFirst ? 3 : 2);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.toolCalls, 1);
  await run(process.execPath, ["--test", "answer.test.mjs"], { cwd: root, windowsHide: true });
});
}
