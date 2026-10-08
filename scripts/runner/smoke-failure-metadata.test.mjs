import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("release gate records redacted multi-round failure metadata in JSON and SSE", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-smoke-diagnostic-"));
  const expected = { status: 403, provider: "workers-ai", model: "@cf/test/model", category: "PERMISSION", round: 1 };
  const raw = { ...expected, body: "PRIVATE_PROVIDER_SENTINEL", token: "PRIVATE_TOKEN_SENTINEL", prompt: "PRIVATE_PROMPT_SENTINEL" };
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/setup/status") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ overall: "ready", completedSteps: 1, totalSteps: 1, optional: { chat: { route: [] } } })); return; }
    if (request.url === "/api/tasks") { response.writeHead(401); response.end(); return; }
    let content = "";
    for await (const chunk of request) content += chunk;
    const streaming = JSON.parse(content).stream;
    const outcome = { stored: true, reply: { content: "_Stopped early: the model endpoint answered 403._" }, steps: [{ label: "Read fixture", ok: true }] };
    if (streaming) {
      response.setHeader("content-type", "text/event-stream");
      response.end(`event: inference_failure\ndata: ${JSON.stringify(raw)}\n\nevent: done\ndata: ${JSON.stringify(outcome)}\n\n`);
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...outcome, inferenceFailure: raw }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const previousDirectory = process.cwd();
  const saved = Object.fromEntries(["ATLAS_OPERATOR_TOKEN", "ATLAS_SMOKE_MODE", "ATLAS_SMOKE_BASE_URL"].map(key => [key, process.env[key]]));
  const originalLog = console.log;
  const logs = [];
  try {
    const script = path.resolve(import.meta.dirname, "smoke-hosted.mjs");
    process.chdir(directory);
    process.env.ATLAS_OPERATOR_TOKEN = "fixture-only";
    process.env.ATLAS_SMOKE_MODE = "chat";
    process.env.ATLAS_SMOKE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    console.log = (...values) => logs.push(values.join(" "));
    await assert.rejects(import(pathToFileURL(script).href), /Chat release gate failed: nonStreaming, streaming/);
    const evidence = JSON.parse(await readFile(path.join(directory, "smoke-result.json"), "utf8"));
    for (const mode of ["nonStreaming", "streaming"]) {
      assert.equal(evidence[mode].passed, false);
      assert.deepEqual(evidence[mode].inferenceFailure, expected);
      assert.equal(evidence[mode].steps[0].ok, true);
    }
    assert.doesNotMatch(JSON.stringify(evidence) + logs.join("\n"), /PRIVATE_(?:PROVIDER|TOKEN|PROMPT)_SENTINEL/);
  } finally {
    console.log = originalLog;
    process.chdir(previousDirectory);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
