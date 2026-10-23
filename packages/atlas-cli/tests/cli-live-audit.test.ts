import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JsonLinesSessionAuditStore } from "../src/infrastructure/json-lines-session-audit-store.js";

test("real coder CLI leaves a replayable partial trace when killed during a model request", { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "atlas-cli-live-audit-"));
  const server = createServer(request => { request.resume(); }); // deliberately never responds
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeFile(join(root, "README.md"), "# audit fixture\n");
  const filePath = join(root, "audit.jsonl");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "code", root,
    "Inspect README.md", "--provider", "groq", "--model", "fixture", "--api-key-env", "ATLAS_TEST_KEY",
    "--base-url", `http://127.0.0.1:${address.port}/v1`, "--audit-log", filePath, "--format", "json"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ATLAS_TEST_KEY: "fixture-key",
    ATLAS_CODER_CONTEXT_WINDOW: "", ATLAS_CODER_MAX_OUTPUT_TOKENS: "" } });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.resume();
  const closed = new Promise<void>(resolve => child.on("close", () => resolve()));
  t.after(async () => {
    child.kill("SIGKILL");
    await closed;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  let content = "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { content = await readFile(filePath, "utf8"); } catch { /* writer has not started */ }
    if (content.includes('"model.requested"') && content.endsWith("\n")) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(content, /"model.requested"/u, "audit must exist while the model is still blocked");
  assert.equal(output, "", "interrupted work must not emit a success result");
  child.kill("SIGKILL");
  await closed;
  const events = await new JsonLinesSessionAuditStore({ filePath, truncatedTailPolicy: "ignore" }).load();
  assert.equal(events[0]?.type, "session.started");
  assert.ok(events.some(event => event.type === "model.requested"));
  assert.ok(!events.some(event => event.type === "session.completed"));
});
