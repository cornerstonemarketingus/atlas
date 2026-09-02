import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const SECRET = "ghp_0123456789abcdefghijABCDEFGHIJ0123";

/**
 * A loopback stand-in for an OpenAI-compatible server that records the exact
 * bodies it is sent.
 */
async function recordingServer(): Promise<{ url: string; bodies: string[]; close: () => Promise<void> }> {
  const bodies: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-1",
        model: "test-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The end-to-end check that unit tests cannot make: that the SHIPPED command
 * wiring actually redacts. Redaction has already been inert in this codebase
 * once — the implementation was complete and correct, and nothing constructed
 * it — so the invariant worth pinning is not "the decorator works" but "the
 * binary does not emit the secret".
 */
test("the real chat command never sends a credential to the model endpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atlas-e2e-redaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "# fixture\n", "utf8");

  const server = await recordingServer();
  t.after(() => server.close());

  await run(process.execPath, [
    CLI, "chat", root,
    `Rotate the token ${SECRET} everywhere it appears.`,
    "--endpoint", server.url,
    "--model", "test-model",
    "--max-turns", "1",
    "--format", "json",
  ]);

  assert.ok(server.bodies.length > 0, "the endpoint was never called");
  for (const body of server.bodies) {
    assert.equal(body.includes(SECRET), false, "the credential reached the model endpoint");
  }
  // Not merely absent — replaced, so the model still knows a token was there.
  assert.match(server.bodies.join(""), /\[redacted:github-token:[0-9a-f]+\]/u);
});
