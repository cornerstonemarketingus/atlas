import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";

test("CLI deadline cancels an in-flight model after an edit and retains progress, audit and undo", async t => {
  const root = await mkdtemp(join(tmpdir(), "atlas-deadline-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "atlas-deadline-artifacts-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outputRoot, { recursive: true, force: true })]));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "source.txt"), "before\n");
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      if (requests > 1) return;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "fixture", model: "openai/gpt-oss-120b", choices: [{ index: 0, message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "edit", type: "function", function: { name: "repository.propose_change_set", arguments: JSON.stringify({ edits: [{ operation: "update", path: "source.txt", content: "after\n" }] }) } }],
      }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const previousKey = process.env["ATLAS_DEADLINE_TEST_KEY"];
  process.env["ATLAS_DEADLINE_TEST_KEY"] = "fixture-key";
  const output: string[] = [];
  const previousLog = console.log, previousError = console.error;
  console.log = (...parts: unknown[]) => output.push(parts.join(" "));
  console.error = () => {};
  try {
    const exit = await main(["code", root, "Update source.txt with the requested text", "--model", "openai/gpt-oss-120b", "--provider", "groq", "--base-url", `http://127.0.0.1:${port}/v1`, "--api-key-env", "ATLAS_DEADLINE_TEST_KEY", "--no-verify", "--retry-attempts", "1", "--execution-timeout-ms", "1000", "--progress-file", join(outputRoot, "progress.json"), "--audit-log", join(outputRoot, "audit.jsonl"), "--format", "json"]);
    assert.equal(exit, 1);
  } finally {
    console.log = previousLog; console.error = previousError;
    if (previousKey === undefined) delete process.env["ATLAS_DEADLINE_TEST_KEY"];
    else process.env["ATLAS_DEADLINE_TEST_KEY"] = previousKey;
  }
  const result = JSON.parse(output.join("\n"));
  assert.equal(requests, 2);
  assert.equal(result.status, "failed");
  assert.match(result.message, /deadline exceeded/);
  assert.deepEqual(result.edits, [{ path: "source.txt", operation: "update" }]);
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "after\n");
  const progress = JSON.parse(await readFile(join(outputRoot, "progress.json"), "utf8"));
  assert.equal(progress.status, "failed");
  assert.equal(progress.phase, "finished");
  const events = (await readFile(join(outputRoot, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === "tool.requested").length, 1);
  assert.equal(events.filter(event => event.type === "model.requested").length, 2);
  assert.ok((await readdir(join(root, ".git", "atlas", "checkpoints"))).includes(`${result.sessionId}.json`));
});
