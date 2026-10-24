import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const execute = promisify(execFile);

interface Seen { path: string; body: any }

// A scripted stand-in for Ollama's native API. The model's answers are fixed;
// everything else (provider, request shape, tool execution, edit, verification)
// is the real CLI. This proves the pipeline, not that a 1.5B model can edit.
async function withFixture(t: test.TestContext, respond: (call: number, body: any) => Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "atlas-ollama-edit-"));
  const original = "export const answer = 1;\n";
  await writeFile(join(root, "answer.mjs"), original);
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node check.mjs" } }));
  await writeFile(join(root, "check.mjs"), 'import {answer} from "./answer.mjs"; if (answer !== 2) process.exit(1);');
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    seen.push({ path: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(respond(seen.length, body)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const run = async (extra: string[] = []) => {
    try {
      const { stdout } = await execute(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "code", root, "Set answer to 2", "--provider", "ollama",
        "--model", "qwen2.5-coder:1.5b", "--base-url", `http://127.0.0.1:${address.port}`, "--context-window", "8192", "--max-output-tokens", "512", "--format", "json", ...extra],
      { timeout: 60000, windowsHide: true, env: { ...process.env, ATLAS_CODER_CONTEXT_WINDOW: "", ATLAS_CODER_MAX_OUTPUT_TOKENS: "", GROQ_API_KEY: "" } });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  };
  return { root, original, seen, run };
}

test("real coder CLI edits a file through the native Ollama provider and verifies it", async t => {
  const f = await withFixture(t, call => call === 1
    ? { model: "qwen2.5-coder:1.5b", message: { role: "assistant", content: "", tool_calls: [{ function: { name: "repository.propose_change_set",
        arguments: { edits: [{ operation: "update", path: "answer.mjs", content: "export const answer = 2;\n" }] } } }] },
        done: true, done_reason: "stop", prompt_eval_count: 900, eval_count: 40 }
    : { model: "qwen2.5-coder:1.5b", message: { role: "assistant", content: "Set answer to 2 and ran the check." }, done: true, done_reason: "stop", prompt_eval_count: 1100, eval_count: 12 });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "completed");
  assert.equal(report.edits.length, 1);
  assert.equal(await readFile(join(f.root, "answer.mjs"), "utf8"), "export const answer = 2;\n");
  assert.equal(report.verification.status, "verified");

  // Provider contract: native endpoint, declared window and output limit sent per request, no credential.
  assert.ok(f.seen.length >= 2);
  for (const request of f.seen) {
    assert.equal(request.path, "/api/chat");
    assert.equal(request.body.model, "qwen2.5-coder:1.5b");
    assert.equal(request.body.stream, false);
    assert.equal(request.body.options.num_ctx, 8192);
    assert.ok(request.body.options.num_predict <= 512);
  }
  assert.ok(f.seen[0]!.body.tools.some((tool: any) => tool.function.name === "repository.propose_change_set"));
  // The tool result goes back in Ollama's shape, named after the call it answers.
  const second = f.seen[1]!.body.messages;
  assert.ok(second.some((m: any) => m.role === "assistant" && m.tool_calls?.[0]?.function?.name === "repository.propose_change_set"));
  assert.ok(second.some((m: any) => m.role === "tool" && m.tool_name === "repository.propose_change_set"));
});

test("a prompt that filled the context window is refused, not trusted, and nothing is edited", async t => {
  const f = await withFixture(t, () => ({ model: "qwen2.5-coder:1.5b",
    message: { role: "assistant", content: "", tool_calls: [{ function: { name: "repository.propose_change_set",
      arguments: { edits: [{ operation: "update", path: "answer.mjs", content: "export const answer = 2;\n" }] } } }] },
    done: true, done_reason: "stop", prompt_eval_count: 8192, eval_count: 40 }));
  const result = await f.run(["--retry-attempts", "1"]);
  assert.notEqual(result.code, 0, "a truncated prompt must not complete");
  assert.equal(await readFile(join(f.root, "answer.mjs"), "utf8"), f.original);
});
