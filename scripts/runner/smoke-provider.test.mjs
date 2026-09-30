import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const available of [true, false]) test(`hosted smoke verifies explicit OpenAI availability=${available}`, async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/setup/status") return res.end(JSON.stringify({ overall: "ready", completedSteps: 1, totalSteps: 1 }));
    if (req.url === "/api/tasks") { res.statusCode = 401; return res.end("{}"); }
    if (req.method === "GET") return res.end(JSON.stringify({ providers: [{ id: "openai", available }] }));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const answer = { conversationId: "fixture", reply: { content: "a private answer" }, stored: true };
    if (body.stream) {
      res.setHeader("content-type", "text/event-stream");
      return res.end(`event: done\ndata: ${JSON.stringify(answer)}\n\n`);
    }
    res.end(JSON.stringify(answer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const directory = await mkdtemp(join(tmpdir(), "atlas-smoke-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("smoke-hosted.mjs", import.meta.url))], {
    cwd: directory, windowsHide: true,
    env: { ...process.env, ATLAS_SMOKE_MODE: "chat", ATLAS_SMOKE_CHAT_PROVIDER: "openai", ATLAS_SMOKE_BASE_URL: `http://127.0.0.1:${server.address().port}`, ATLAS_OPERATOR_TOKEN: "fixture-only" },
  });
  let output = "";
  child.stdout.on("data", (part) => { output += part; });
  child.stderr.on("data", (part) => { output += part; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  if (available) assert.equal(code, 0, output);
  else {
    assert.notEqual(code, 0, output);
    assert.match(output, /Selected chat provider is not available/u);
  }
  assert.equal(requests.length, available ? 2 : 0);
  if (available) {
    assert.deepEqual(requests.map((request) => request.provider), ["openai", "openai"]);
    assert.equal(requests[1].stream, true);
    const evidence = await readFile(join(directory, "smoke-result.json"), "utf8");
    assert.equal(JSON.parse(evidence).provider, "openai");
    assert.doesNotMatch(evidence, /private answer|fixture-only/u);
  }
});
