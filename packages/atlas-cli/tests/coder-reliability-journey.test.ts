import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("real CLI repairs aliases, reads and patches an about page, executes checks and retains audit evidence", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "atlas-coder-reliability-"));
  const root = join(temporary, "repo");
  const page = "apps/web/app/about/page.tsx";
  const original = 'export default function About() { return <h1>TODO: describe Atlas</h1>; }\n';
  const updated = 'export default function About() { return <h1>Atlas helps you complete verified software tasks.</h1>; }\n';
  await mkdir(join(root, "apps/web/app/about"), { recursive: true });
  await writeFile(join(root, page), original);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }));
  await writeFile(join(root, "check.mjs"), [
    "import assert from 'node:assert/strict'; import fs from 'node:fs';",
    "assert.equal(process.env.ATLAS_RELIABILITY_TEST_KEY, undefined);",
    `assert.match(fs.readFileSync(${JSON.stringify(page)}, 'utf8'), /<h1>.+<\\/h1>/);`,
    "fs.appendFileSync('checks-executed.txt', 'test executed\\n');",
  ].join("\n"));
  let requests = 0;
  const calls = [
    { name: "repo_browser.search", arguments: { query: "TODO" } },
    { name: "repositoryReadFile", arguments: { path: page } },
    { name: "repository.propose_change_set", arguments: { edits: [{ operation: "update", path: page, content: updated }] } },
  ];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request before replying */ }
    const call = calls[requests++];
    const message = call
      ? { content: null, tool_calls: [{ id: `call-${requests}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { content: "Updated the about page." };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: `reply-${requests}`, model: "fixture", choices: [{ message, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const audit = join(temporary, "audit.jsonl");
  const { stdout } = await execute(process.execPath, [join(process.cwd(), "dist/src/cli.js"),
    "code", root, `Fix the TODO in ${page}`, "--provider", "groq", "--model", "fixture",
    "--base-url", `http://127.0.0.1:${address.port}/v1`, "--api-key-env", "ATLAS_RELIABILITY_TEST_KEY",
    "--audit-log", audit, "--retry-attempts", "1", "--verify-timeout-ms", "10000", "--format", "json",
  ], { timeout: 30000, windowsHide: true, env: { ...process.env, ATLAS_RELIABILITY_TEST_KEY: "fixture-secret", ATLAS_CODER_CONTEXT_WINDOW: "", ATLAS_CODER_MAX_OUTPUT_TOKENS: "" } });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.verification.status, "verified");
  assert.deepEqual(result.edits.map((edit: { path: string }) => edit.path), [page]);
  assert.equal(await readFile(join(root, page), "utf8"), updated);
  assert.equal(await readFile(join(root, "checks-executed.txt"), "utf8"), "test executed\ntest executed\n");
  assert.equal(requests, 4, "aliases must execute without corrective model requests");
  const trace = (await readFile(audit, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const repaired = trace.filter((event) => event.type === "tool.requested" && event.payload.repair === "automatic");
  assert.deepEqual(repaired.map((event) => [event.payload.requestedToolId, event.payload.toolId]), [
    ["repo_browser.search", "repository.search"], ["repositoryReadFile", "repository.read_source"],
  ]);
  assert.doesNotMatch(JSON.stringify(trace), /fixture-secret/);
});
