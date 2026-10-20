import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { ArtifactStore, recordGenesisArtifact } from "../src/platform/artifacts/index.mjs";
import { RenderRunner } from "../src/platform/render/index.mjs";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor } from "../src/platform/genesis/executor.mjs";
import { PreviewManager } from "../src/platform/genesis/preview.mjs";
import { inspectOverHttp } from "../src/platform/genesis/inspector.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";

/**
 * The sprint's cross-lane journey (ENGINEERING-PLAN-2026 §5), through the
 * daemon's real HTTP handler: one sentence becomes a verified Genesis project
 * (with stage snapshots), a render inside the container sandbox turns into a
 * video artifact viewable over HTTP, and after the workspace is lost the
 * project restores from its snapshot and renders again.
 *
 * The container runtime is a stand-in (CI has no Docker): it acts on the
 * staging directory the runner mounts, exactly as the real container sees
 * /workspace. The real-container render is covered in platform-render.test.mjs.
 */
const TOKEN = "journey-owner-token-0123456789abcdefghijklmnop";
const owner = { authorization: `Bearer ${TOKEN}` };
const SANDBOX = Object.freeze({ runtime: "/usr/bin/docker", image: "node:22-bookworm-slim", cpus: 1, memoryBytes: 512 * 1024 ** 2, pidsLimit: 64, tmpfsBytes: 16 * 1024 ** 2 });
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 7)]);

function containerStandIn() {
  const runs = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    const staging = /source=(.*),target=\/workspace$/u.exec(args[args.indexOf("--mount") + 1] ?? "")?.[1];
    runs.push({ file, args });
    setImmediate(() => {
      mkdirSync(join(staging, "out"), { recursive: true });
      writeFileSync(join(staging, "out", "clip.mp4"), MP4);
      child.emit("close", 0, null);
    });
    return child;
  };
  return { spawn, runs };
}

const job = { tool: "ffmpeg", args: ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10", "out/clip.mp4"], inputs: [], outputs: ["out/clip.mp4"] };

async function json(response) { return { status: response.status, body: await response.json() }; }

test("sentence → verified project → sandboxed render → video artifact over HTTP → restore → render again", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atlas-journey-"));
  const local = new LocalTaskStore(join(root, "local.sqlite"));
  const artifacts = new ArtifactStore({ root: join(root, "artifacts") });
  const genesisStore = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store: genesisStore, policy: () => ({ decision: "allow" }) });
  const preview = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  const executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck, preview, inspector: async (project, running) => inspectOverHttp(project, running) });
  const container = containerStandIn();
  const render = new RenderRunner({ container: { runtime: SANDBOX.runtime }, resolveSandbox: () => SANDBOX, images: { ffmpeg: "atlas/ffmpeg:test" }, spawn: container.spawn, killContainer: () => true, knownSecrets: [], artifactStore: artifacts });
  const server = createLocalControlServer({ store: local, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), genesis, artifacts, render });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await preview.stopAll();
    await new Promise((resolve) => server.close(resolve));
    local.close(); artifacts.close(); genesisStore.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  // 1. One sentence to a verified, running project; every stage starts from a snapshot.
  const project = await genesis.create("Build a REST API for managing inventory items");
  const ready = await executor.run(project.id);
  assert.equal(ready.state, "ready", JSON.stringify(ready.transitions.at(-1)));
  assert.ok(genesisStore.snapshots(project.id).length >= 4);
  const site = await recordGenesisArtifact({ artifacts, project: ready });
  assert.ok(site.artifact?.sha256, "the ready project is recorded as an artifact");

  // 2. The daemon says what it can render, then renders inside the sandbox.
  const status = await json(await fetch(`${origin}/v1/render`, { headers: owner }));
  assert.deepEqual(status.body.render.capabilities, ["render.ffmpeg"]);
  const rendered = await json(await fetch(`${origin}/v1/render/jobs`, { method: "POST", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, job }) }));
  assert.equal(rendered.status, 200, JSON.stringify(rendered.body));
  const [file] = rendered.body.result.files;
  assert.equal(file.path, "out/clip.mp4");
  assert.equal(file.artifact.sha256, file.sha256);
  assert.equal(container.runs.length, 1);
  assert.ok(container.runs[0].args.includes("--network") && container.runs[0].args.includes("none"), "the render ran with the network off");

  // 3. The video is an artifact the viewer can stream (Range) with the project as provenance.
  const listed = await json(await fetch(`${origin}/v1/artifacts?kind=video`, { headers: owner }));
  assert.equal(listed.body.artifacts.length, 1);
  assert.equal(listed.body.artifacts[0].provenance.runId, project.id);
  const content = await fetch(`${origin}/v1/artifacts/${file.sha256}/content`, { headers: { ...owner, range: "bytes=4-11" } });
  assert.equal(content.status, 206);
  assert.equal(content.headers.get("content-type"), "video/mp4");
  assert.equal(Buffer.from(await content.arrayBuffer()).toString("latin1"), "ftypisom");

  // A paired phone can watch, but cannot start a render (execution on this computer).
  const phoneToken = "paired-phone-token-0123456789abcdefghijklmnop";
  local.addDevice("Phone", createHash("sha256").update(phoneToken).digest("hex"));
  const phone = await fetch(`${origin}/v1/render/jobs`, { method: "POST", headers: { authorization: `Bearer ${phoneToken}`, "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, job }) });
  assert.equal(phone.status, 403);
  assert.equal((await fetch(`${origin}/v1/render`, { headers: { authorization: `Bearer ${phoneToken}` } })).status, 200);
  assert.equal(container.runs.length, 1, "the refused request started nothing");

  // 4. The workspace is lost; the project restores from its verified snapshot, rebuilds and renders again.
  await preview.stopAll();
  rmSync(ready.workspace, { recursive: true, force: true });
  const receipt = await executor.resumeFromSnapshot(project.id);
  assert.equal(receipt.restored, true, JSON.stringify(receipt));
  const again = await executor.run(project.id);
  assert.equal(again.state, "ready", JSON.stringify(again.transitions.at(-1)));
  assert.notEqual(again.workspace, ready.workspace);
  const second = await json(await fetch(`${origin}/v1/render/jobs`, { method: "POST", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, job }) }));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.result.files[0].artifact.created, false, "the same bytes are the same artifact");
});

test("without a container sandbox, rendering over HTTP fails closed and says why", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atlas-journey-closed-"));
  const local = new LocalTaskStore(join(root, "local.sqlite"));
  const genesisStore = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store: genesisStore, policy: () => ({ decision: "allow" }) });
  let spawned = 0;
  const render = new RenderRunner({ container: undefined, images: { ffmpeg: "atlas/ffmpeg:test" }, spawn: () => { spawned++; throw new Error("must not spawn"); }, knownSecrets: [] });
  const server = createLocalControlServer({ store: local, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), genesis, render });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); local.close(); genesisStore.close(); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const workspace = join(root, "projects", "p");
  mkdirSync(dirname(join(workspace, "x")), { recursive: true });
  const project = await genesis.create("Build a REST API for managing inventory items");
  genesisStore.transition("local", project.id, "scaffolding", { reason: "test workspace", patch: { workspace } });
  assert.equal(genesis.view(project.id).workspace, workspace);

  const status = await json(await fetch(`${origin}/v1/render`, { headers: owner }));
  assert.equal(status.body.render.available, false);
  assert.match(status.body.render.reason, /container sandbox/u);
  const refused = await fetch(`${origin}/v1/render/jobs`, { method: "POST", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, job }) });
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).code, "REQUIRES_CONTAINER_SANDBOX");
  assert.equal(spawned, 0, "nothing was started on the host");
  const unauthenticated = await fetch(`${origin}/v1/render/jobs`, { method: "POST", body: "{}" });
  assert.equal(unauthenticated.status, 401);
});
