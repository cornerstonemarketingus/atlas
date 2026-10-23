import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AtlasNodeAgent } from "../src/node/agent.mjs";

const token = "node-cancellation-token-0123456789abcdef";
const bytes = Buffer.from("a render input");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const hardware = async () => ({ cpuCount: 2, totalMemoryGiB: 4, gpus: [] });

async function bounded(promise, message, ms = 2_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}

for (const stalled of ["register headers", "register body", "claim headers", "claim body", "input body", "upload body"]) {
  test(`node shutdown cancels stalled ${stalled}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atlas-node-abort-"));
    const controller = new AbortController();
    let entered;
    const waiting = new Promise((resolve) => { entered = resolve; });
    let disconnected;
    const closed = new Promise((resolve) => { disconnected = resolve; });
    const job = {
      id: "nj_cancel", claimId: "current-claim", requirements: {}, render: {},
      inputs: stalled === "input body" ? [{ path: "input.bin", sha256, bytes: bytes.length }] : [],
    };
    let renderCalls = 0;
    let completeCalls = 0;
    const render = {
      status: () => ({ available: true }), registryCapabilities: () => ["ffmpeg"],
      async run(workspace) {
        renderCalls += 1;
        await writeFile(join(workspace, "out.mp4"), bytes);
        return { ok: true, files: [{ path: "out.mp4", sha256 }] };
      },
    };
    const server = createServer(async (request, response) => {
      for await (const _ of request) { /* drain the actual request body */ }
      const path = new URL(request.url, "http://local").pathname;
      if (path.endsWith("/complete")) completeCalls += 1;
      const phase = path.endsWith("/register") ? "register" : path.endsWith("/claim") ? "claim"
        : path.includes("/inputs/") ? "input" : path.endsWith("/outputs") ? "upload" : "other";
      if (stalled.startsWith(`${phase} `)) {
        response.on("close", disconnected);
        if (stalled.endsWith("body")) {
          response.writeHead(200, { "content-type": phase === "input" ? "application/octet-stream" : "application/json" });
          response.write(phase === "input" ? bytes.subarray(0, 1) : "{");
        }
        entered();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(phase === "claim" ? { job } : {}));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const agent = new AtlasNodeAgent({
      daemonUrl: `http://127.0.0.1:${server.address().port}`, token, render, workRoot: root,
      detectHardwareImpl: hardware, heartbeatIntervalMs: 60_000, claimWaitMs: 20_000,
    });
    let running;
    t.after(async () => {
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await running?.catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    running = agent.run({ signal: controller.signal, backoffMs: 50 });
    running.catch(() => {});
    await bounded(waiting, "node did not reach the stalled request", 10_000);
    controller.abort();
    assert.deepEqual(await bounded(running, `shutdown did not cancel ${stalled}`), { stopped: "signal" });
    await bounded(closed, `shutdown left the ${stalled} connection open`);
    assert.equal(renderCalls, stalled === "upload body" ? 1 : 0);
    assert.equal(completeCalls, 0, "shutdown never reports the unfinished job as complete");
    assert.deepEqual(await readdir(root), [], "partial job workspaces are removed on cancellation");
  });
}

test("an already stopped node never registers", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const agent = new AtlasNodeAgent({
    daemonUrl: "http://127.0.0.1", token, render: { run() {}, status() {}, registryCapabilities: () => [] },
    detectHardwareImpl: hardware, fetchImpl: async () => { requests += 1; return new Response("{}"); },
  });
  assert.deepEqual(await agent.run({ signal: controller.signal }), { stopped: "signal" });
  assert.equal(requests, 0);
});
