import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";

const runtime = process.env["ATLAS_TEST_CONTAINER_RUNTIME"];
test("native CLI edits, observes a real container test failure, repairs and verifies the diff", { skip: !runtime }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atlas-cloud-coder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = { name: "container-fixture", version: "1.0.0", type: "module", scripts: { test: "node --test check.test.mjs" } };
  await writeFile(join(root, "package.json"), JSON.stringify(pkg));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { "": { name: pkg.name, version: pkg.version } } }));
  await writeFile(join(root, "source.txt"), "before");
  const check = (expected: string) => `import assert from 'node:assert/strict'; import fs from 'node:fs';
    assert.equal(process.env.ATLAS_CONTAINER_TEST_KEY, undefined);
    assert.equal(fs.readFileSync('source.txt', 'utf8'), ${JSON.stringify(expected)});
    fs.writeFileSync('untrusted-test-output.txt', 'must never become a coder edit');`;
  await writeFile(join(root, "check.test.mjs"), check("before"));
  let turns = 0;
  let repairEvidence = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      turns++;
      if (turns === 3) repairEvidence = Buffer.concat(chunks).toString().includes("Validation failures your previous edits introduced");
      const change = turns === 1 ? { path: "source.txt", content: "coder edit" } : { path: "check.test.mjs", content: check("coder edit") };
      const editing = turns === 1 || turns === 3;
      const message = editing
        ? { role: "assistant", content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: "repository.propose_change_set", arguments: JSON.stringify({ edits: [{ operation: "update", ...change }] }) } }] }
        : { role: "assistant", content: "Completed." };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: `r${turns}`, model: "openai/gpt-oss-120b", choices: [{ index: 0, message, finish_reason: editing ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const output: string[] = [];
  const log = console.log;
  const error = console.error;
  const previousKey = process.env["ATLAS_CONTAINER_TEST_KEY"];
  console.log = (...parts: unknown[]) => output.push(parts.join(" "));
  console.error = () => {};
  process.env["ATLAS_CONTAINER_TEST_KEY"] = "fixture-secret";
  try {
    const exit = await main(["code", root, "Change the source and its tests", "--model", "openai/gpt-oss-120b", "--provider", "groq", "--base-url", `http://127.0.0.1:${port}/v1`, "--api-key-env", "ATLAS_CONTAINER_TEST_KEY", "--verify-container", runtime!, "--retry-attempts", "1", "--format", "json"]);
    assert.equal(exit, 0, output.join("\n"));
  } finally {
    console.log = log;
    console.error = error;
    if (previousKey === undefined) delete process.env["ATLAS_CONTAINER_TEST_KEY"];
    else process.env["ATLAS_CONTAINER_TEST_KEY"] = previousKey;
  }
  const result = JSON.parse(output.join("\n")) as { verification: { status: string; attempts: number } };
  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.attempts, 2);
  assert.equal(repairEvidence, true);
  assert.equal(turns, 4);
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "coder edit");
  await assert.rejects(readFile(join(root, "untrusted-test-output.txt")), /ENOENT/u);
});
