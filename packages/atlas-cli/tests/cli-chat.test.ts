import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("runs read-only chat end to end against a local compatible endpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atlas-chat-cli-"));
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: "response-1",
      model: "test-model",
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "The repository contains a README." },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    join(process.cwd(), "dist", "src", "cli.js"),
    "chat",
    root,
    "Explain this repository",
    "--endpoint",
    endpoint,
    "--model",
    "test-model",
    "--format",
    "json",
  ], { timeout: 10_000, windowsHide: true });

  assert.equal(stderr, "");
  const output = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(output["status"], "completed");
  assert.equal(output["response"], "The repository contains a README.");
  assert.equal(output["inputTokens"], 10);
  assert.equal(output["messages"], undefined);
});
