import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const execute = promisify(execFile);

for (const recovers of [true, false]) {
  test(`real coder ${recovers ? "recovers and verifies edits" : "blocks without edits"} after textual tool output`, async t => {
    const root = await mkdtemp(join(tmpdir(), "atlas-textual-tool-"));
    const original = "export const answer = 1;\n";
    await writeFile(join(root, "answer.mjs"), original);
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node check.mjs" } }));
    await writeFile(join(root, "check.mjs"), 'import {answer} from "./answer.mjs"; if (![1,2].includes(answer)) process.exit(1);');
    const operation = { name: "repository.propose_change_set", arguments: { edits: [
      { operation: "update", path: "answer.mjs", content: "export const answer = 2;\n" },
    ] } };
    let calls = 0;
    let textExecuted = false;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume fixture request */ }
      calls++;
      if (calls === 2) textExecuted = (await readFile(join(root, "answer.mjs"), "utf8")) !== original;
      const message = calls === 1 || !recovers
        ? { content: "```json\n" + JSON.stringify(operation) + "\n```" }
        : calls === 2 ? { content: null, tool_calls: [{ id: "actual-edit", type: "function", function: {
          name: operation.name, arguments: JSON.stringify(operation.arguments),
        } }] } : { content: "Updated answer.mjs and checked the result." };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: `fixture-${calls}`, model: "fixture", choices: [{ message,
        finish_reason: calls === 2 && recovers ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    let stdout: string;
    try {
      ({ stdout } = await execute(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "code", root, "Set answer to 2", "--provider", "groq",
        "--model", "fixture", "--api-key-env", "ATLAS_TEST_KEY", "--base-url", `http://127.0.0.1:${address.port}/v1`, "--format", "json"],
      { timeout: 30000, windowsHide: true, env: { ...process.env, ATLAS_TEST_KEY: "fixture-key", ATLAS_CODER_CONTEXT_WINDOW: "", ATLAS_CODER_MAX_OUTPUT_TOKENS: "" } }));
    } catch (error) {
      if (recovers) throw error;
      assert.equal((error as { code?: number }).code, 1);
      stdout = (error as { stdout: string }).stdout;
    }
    const result = JSON.parse(stdout);
    assert.equal(result.status, recovers ? "completed" : "blocked");
    assert.equal(calls, recovers ? 3 : 2);
    assert.equal(textExecuted, false, "textual JSON must never execute");
    assert.equal(result.edits.length, recovers ? 1 : 0);
    assert.equal(await readFile(join(root, "answer.mjs"), "utf8"), recovers ? "export const answer = 2;\n" : original);
    if (recovers) {
      assert.equal(result.verification.status, "verified");
      const { stdout: independent } = await execute(process.execPath, ["--input-type=module", "-e", 'import {answer} from "./answer.mjs"; if(answer!==2)process.exit(1); console.log("verified");'], { cwd: root, windowsHide: true });
      assert.match(independent, /verified/u);
    }
  });
}
