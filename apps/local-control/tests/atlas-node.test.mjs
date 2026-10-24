import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { PlatformTaskStore } from "../src/platform/index.mjs";
import { ArtifactStore } from "../src/platform/artifacts/index.mjs";
import { RENDER_ARTIFACT_TYPES, RenderRunner, buildBlenderJob } from "../src/platform/render/index.mjs";
import { ComputeLeaseStore, ComputeManager, FakeClock, FakeGpuProvider } from "../src/platform/compute/index.mjs";
import {
  LOCAL_OWNER_ID, NODE_OUTPUT_TYPES, NodeProvider, NodeService, defaultComputeProviders, nodeRenderJob, runNodeRender,
} from "../src/platform/nodes/index.mjs";
import { AtlasNodeAgent, nodeCapabilities, validateDaemonUrl } from "../src/node/agent.mjs";
import { nodeOptionsFromArgs } from "../src/node/main.mjs";

/**
 * Atlas Node end to end at real boundaries: the daemon's real HTTP handler,
 * temp SQLite for the registry, jobs and leases, the real artifact store, and
 * node agents talking to it over HTTP. The container runtime is a stand-in
 * (CI has no Docker) that acts on the staging directory RenderRunner mounts,
 * as in sprint-journey.test.mjs; RenderRunner itself is real, so the
 * container-only invocation check runs on every job.
 */

const TOKEN = "atlas-node-owner-token-0123456789abcdefghijkl";
const owner = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const SANDBOX = Object.freeze({ runtime: "/usr/bin/docker", image: "node:22-bookworm-slim", cpus: 1, memoryBytes: 512 * 1024 ** 2, pidsLimit: 64, tmpfsBytes: 16 * 1024 ** 2 });
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]);
const CLAIM_TTL_MS = 30_000;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const ffmpegJob = (outputs = ["out/clip.mp4"]) => ({ tool: "ffmpeg", args: ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10", ...outputs], inputs: [], outputs });
const ffmpegWithInput = { tool: "ffmpeg", args: ["-i", "in/src.mp4", "-vf", "scale=32:32", "out/small.mp4"], inputs: ["in/src.mp4"], outputs: ["out/small.mp4"] };

/** A container runtime stand-in: writes each declared output into the mounted staging directory. */
function containerStandIn({ files = (staging) => ({ "out/clip.mp4": MP4 }), beforeExit = async () => {} } = {}) {
  const runs = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    const staging = /source=(.*),target=\/workspace$/u.exec(args[args.indexOf("--mount") + 1] ?? "")?.[1];
    runs.push({ file, args, staging });
    setImmediate(async () => {
      for (const [rel, bytes] of Object.entries(files(staging))) {
        mkdirSync(dirname(join(staging, rel)), { recursive: true });
        writeFileSync(join(staging, rel), bytes);
      }
      await beforeExit(staging);
      child.emit("close", 0, null);
    });
    return child;
  };
  return { spawn, runs };
}

const cpuOnly = async () => ({ cpuCount: 8, totalMemoryGiB: 16, freeMemoryGiB: 8, gpus: [], unifiedMemory: false, accelerator: "cpu" });

async function fixture(t, { claimTtlMs = CLAIM_TTL_MS } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-node-"));
  const clock = new FakeClock(Date.now());
  const local = new LocalTaskStore(join(root, "local.sqlite"));
  const artifacts = new ArtifactStore({ root: join(root, "artifacts") });
  const platform = new PlatformTaskStore(join(root, "platform.sqlite"));
  const nodes = new NodeService({ db: join(root, "nodes.sqlite"), artifacts, root: join(root, "node-data"), isOwner: ({ userId }) => userId === LOCAL_OWNER_ID, clock: () => clock.now(), claimTtlMs });
  const nodeProvider = new NodeProvider({ service: nodes, pollMs: 200 });
  const leases = new ComputeLeaseStore(join(root, "compute.sqlite"));
  const manager = new ComputeManager({ store: platform, leases, providers: defaultComputeProviders({ nodeProvider }), clock, idleTimeoutSec: 120 });
  const server = createLocalControlServer({ store: local, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), artifacts, nodes });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agents = [];
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    for (const handle of [local, artifacts, platform, nodes, leases]) { try { handle.close(); } catch { /* closed */ } }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const f = {
    root, clock, local, artifacts, platform, nodes, nodeProvider, manager, origin, agents,
    async ownerCall(method, path, body) {
      const response = await fetch(`${origin}${path}`, { method, headers: owner, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    /** Owner mints a node; returns its id and token. */
    async mint(name = "Laptop") {
      const created = await f.ownerCall("POST", "/v1/nodes", { name });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return { id: created.body.node.id, token: created.body.nodeToken };
    },
    approve(id) { return f.ownerCall("POST", `/v1/nodes/${id}/approve`, {}); },
    revoke(id, reason = "lost laptop") { return f.ownerCall("POST", `/v1/nodes/${id}/revoke`, { reason }); },
    /** A node agent with a stand-in container and the given render images. */
    agent(token, { images = { ffmpeg: "atlas/ffmpeg:test" }, container = containerStandIn(), detectHardwareImpl = cpuOnly } = {}) {
      const render = new RenderRunner({ container: { runtime: SANDBOX.runtime }, resolveSandbox: () => SANDBOX, images, spawn: container.spawn, killContainer: () => true, knownSecrets: [], stagingRoot: root });
      const agent = new AtlasNodeAgent({ daemonUrl: origin, token, render, workRoot: root, detectHardwareImpl, heartbeatIntervalMs: 60_000, claimWaitMs: 0 });
      agent.container = container;
      agents.push(agent);
      return agent;
    },
    /** An approved, registered, live node. */
    async approvedAgent(name, options) {
      const { id, token } = await f.mint(name);
      const agent = f.agent(token, options);
      await agent.register();
      const approved = await f.approve(id);
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      agent.nodeId = id; agent.token = token;
      return agent;
    },
    /** Raw node HTTP, for steps the agent would never do on its own. */
    async nodeCall(token, method, path, { json, body, headers = {} } = {}) {
      const response = await fetch(`${origin}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: json !== undefined ? JSON.stringify(json) : body,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    queue(render = ffmpegJob(), extra = {}) {
      return nodes.submit({ tenantId: "local", render, deadlineAt: clock.now() + 3_600_000, ...extra });
    },
  };
  return f;
}

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

test("an unapproved node is never given a job, and the compute manager will not schedule onto it", async (t) => {
  const f = await fixture(t);
  const { id, token } = await f.mint("Friend's desktop");
  const agent = f.agent(token);
  const registered = await agent.register();
  assert.equal(registered.node.status, "awaiting_approval");
  assert.equal(registered.worker.trust, "untrusted");
  assert.deepEqual(registered.worker.capabilities.cpu, { cores: 8, memoryGiB: 16 }, "CPU cores and memory come from hardware detection");
  assert.deepEqual(registered.worker.capabilities.render, ["ffmpeg"], "render tools come from RenderRunner.status()");

  // The compute manager sees no eligible node, so nothing is provisioned.
  await assert.rejects(f.manager.start({ tenantId: "local", taskId: "task-1", job: nodeRenderJob({ id: "job-unapproved", render: ffmpegJob() }) }), { code: "NO_GPU_AVAILABLE" });
  assert.equal(f.manager.listLeases("local").length, 0);

  // Even with a job sitting in the queue, the unapproved node gets nothing.
  const queued = await f.queue();
  const outcome = await agent.runOnce({ waitMs: 0 });
  assert.equal(outcome.claimed, false);
  assert.match(outcome.reason, /approve/u);
  assert.equal(f.nodes.getJob("local", queued.id).state, "queued");
  assert.equal(agent.container.runs.length, 0, "nothing ran");

  const listed = await f.ownerCall("GET", "/v1/nodes");
  assert.equal(listed.body.nodes[0].status, "awaiting_approval");
  assert.equal(JSON.stringify(listed.body).includes(token), false, "the token is never listed");

  // Approval is owner-only: a node token cannot approve itself.
  const self = await f.nodeCall(token, "POST", `/v1/nodes/${id}/approve`, { json: {} });
  assert.equal(self.status, 401);
  assert.equal((await f.approve(id)).status, 200);
  const after = await agent.runOnce({ waitMs: 0 });
  assert.equal(after.claimed, true, "approval is what opened the gate");
  assert.equal(after.status, "succeeded");
});

test("a node token reaches only the node routes, and only https (or loopback http) daemons are dialled", async (t) => {
  const f = await fixture(t);
  const { token } = await f.mint();
  assert.equal((await f.nodeCall(token, "GET", "/v1/tasks")).status, 401, "not a device or owner token");
  assert.equal((await f.nodeCall(token, "GET", "/v1/nodes")).status, 401);
  assert.equal((await f.nodeCall("not-a-real-node-token-000000000000000000", "POST", "/v1/node/heartbeat", { json: {} })).status, 401);

  assert.equal(validateDaemonUrl("https://atlas.example.com").protocol, "https:");
  assert.equal(validateDaemonUrl("http://127.0.0.1:8787").hostname, "127.0.0.1");
  assert.throws(() => validateDaemonUrl("http://atlas.example.com"), { code: "INSECURE_DAEMON_URL" });
  assert.throws(() => validateDaemonUrl("https://user:pw@atlas.example.com"), { code: "INVALID_DAEMON_URL" });
  assert.throws(() => nodeOptionsFromArgs(["--daemon", "https://atlas.example.com"], {}), /ATLAS_NODE_TOKEN/u);
  const options = nodeOptionsFromArgs(["--daemon", "https://atlas.example.com", "--token-env", "MY_NODE_TOKEN"], { MY_NODE_TOKEN: "x".repeat(43) });
  assert.equal(options.token.length, 43);
  assert.equal(options.container, undefined, "no container runtime configured: the node will declare no render capability");
  const bare = new RenderRunner({ container: undefined, images: { ffmpeg: "atlas/ffmpeg:test" }, knownSecrets: [] });
  const caps = await nodeCapabilities({ render: bare, detectHardwareImpl: cpuOnly });
  assert.deepEqual(caps.render, [], "without a sandbox a node never claims render work");
});

// ---------------------------------------------------------------------------
// The happy path through ComputeManager
// ---------------------------------------------------------------------------

test("an approved CPU node claims, renders in its container sandbox, uploads verified outputs, at $0", async (t) => {
  const f = await fixture(t);
  const container = containerStandIn({ files: (staging) => {
    assert.deepEqual(readFileSync(join(staging, "in", "src.mp4")), MP4, "the input arrived, verified, in the sandbox staging copy");
    return { "out/small.mp4": MP4 };
  } });
  const agent = await f.approvedAgent("Laptop", { container });
  const workspace = join(f.root, "daemon-workspace");
  mkdirSync(join(workspace, "in"), { recursive: true });
  writeFileSync(join(workspace, "in", "src.mp4"), MP4);

  const job = nodeRenderJob({ id: "job-cpu-1", render: ffmpegWithInput, workspace });
  const running = runNodeRender({ manager: f.manager, provider: f.nodeProvider, tenantId: "local", taskId: "task-1", job });
  let outcome;
  for (let i = 0; i < 50 && !outcome?.claimed; i++) outcome = await agent.runOnce({ waitMs: 200 });
  assert.equal(outcome.status, "succeeded", JSON.stringify(outcome));
  const result = await running;
  assert.equal(result.status, "succeeded", String(result.error?.message));
  const [output] = result.outputs.outputs;
  assert.equal(output.path, "out/small.mp4");
  assert.equal(output.sha256, sha(MP4));
  assert.equal(f.artifacts.get("local", sha(MP4))?.kind, "video", "the output is in the artifact store");

  const lease = f.manager.getLease("local", result.leaseId);
  assert.equal(lease.provider, "atlas-node");
  assert.equal(lease.reservedMicroUsd, 0);
  assert.equal(lease.state, "settled");
  assert.equal(lease.actualMicroUsd, 0, "a node costs nothing");
  assert.equal(container.runs.length, 1);
  assert.equal(container.runs[0].file, SANDBOX.runtime, "only the container runtime was started");
  assert.equal(container.runs[0].args[container.runs[0].args.indexOf("--network") + 1], "none");
  assert.equal(existsSync(container.runs[0].staging), false, "the staging copy is gone");
});

test("Blender Cycles on CPU is first-class: a CPU node renders a frame and returns a PNG", async (t) => {
  const f = await fixture(t);
  const blender = buildBlenderJob({ scene: "scenes/shot.blend", output: "renders/shot_####", frame: 7, engine: "CYCLES", threads: 4 });
  const container = containerStandIn({ files: () => Object.fromEntries(blender.outputs.map((path) => [path, PNG])) });
  const agent = await f.approvedAgent("Desktop", { container, images: { blender: "atlas/blender:test" } });
  const workspace = join(f.root, "blend-ws");
  mkdirSync(join(workspace, "scenes"), { recursive: true });
  writeFileSync(join(workspace, "scenes", "shot.blend"), "BLENDER-v300 fake scene");

  const running = runNodeRender({ manager: f.manager, provider: f.nodeProvider, tenantId: "local", taskId: "task-1", job: nodeRenderJob({ id: "frame-7", render: blender, workspace, cpu: { minCores: 4 } }) });
  let outcome;
  for (let i = 0; i < 50 && !outcome?.claimed; i++) outcome = await agent.runOnce({ waitMs: 200 });
  const result = await running;
  assert.equal(result.status, "succeeded", String(result.error?.message));
  assert.equal(result.outputs.outputs[0].mediaType, "image/png");
  assert.ok(container.runs[0].args.includes("CYCLES"));
});

// ---------------------------------------------------------------------------
// Output verification
// ---------------------------------------------------------------------------

test("an upload whose bytes do not match the declared sha256 is refused and nothing is stored", async (t) => {
  const f = await fixture(t);
  const agent = await f.approvedAgent("Laptop");
  const queued = await f.queue();
  const claim = await f.nodeCall(agent.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } });
  assert.equal(claim.body.job.id, queued.id);
  const { claimId } = claim.body.job;
  const outputs = `/v1/node/jobs/${queued.id}/outputs?claim=${claimId}&path=out%2Fclip.mp4`;

  const tampered = Buffer.concat([MP4, Buffer.from("tampered")]);
  const refused = await f.nodeCall(agent.token, "PUT", outputs, { body: tampered, headers: { "x-atlas-sha256": sha(MP4) } });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "DIGEST_MISMATCH");
  assert.equal(f.artifacts.list("local").length, 0, "refused bytes never reach the artifact store");
  const early = await f.nodeCall(agent.token, "POST", `/v1/node/jobs/${queued.id}/complete`, { json: { claimId, files: [{ path: "out/clip.mp4", sha256: sha(MP4) }] } });
  assert.equal(early.status, 422);
  assert.equal(early.body.code, "OUTPUT_MISSING", "a job cannot complete on a refused upload");

  // An undeclared path, or no digest at all, is refused too.
  assert.equal((await f.nodeCall(agent.token, "PUT", `/v1/node/jobs/${queued.id}/outputs?claim=${claimId}&path=etc%2Fpasswd.mp4`, { body: MP4, headers: { "x-atlas-sha256": sha(MP4) } })).body.code, "OUTPUT_NOT_DECLARED");
  assert.equal((await f.nodeCall(agent.token, "PUT", outputs, { body: MP4 })).body.code, "DIGEST_REQUIRED");

  const stored = await f.nodeCall(agent.token, "PUT", outputs, { body: MP4, headers: { "x-atlas-sha256": sha(MP4) } });
  assert.equal(stored.status, 201);
  const wrongClaim = await f.nodeCall(agent.token, "POST", `/v1/node/jobs/${queued.id}/complete`, { json: { claimId, files: [{ path: "out/clip.mp4", sha256: sha(PNG) }] } });
  assert.equal(wrongClaim.body.code, "DIGEST_MISMATCH", "completion must name the digest that was uploaded");
  const done = await f.nodeCall(agent.token, "POST", `/v1/node/jobs/${queued.id}/complete`, { json: { claimId, files: [{ path: "out/clip.mp4", sha256: sha(MP4) }] } });
  assert.equal(done.status, 200);
  assert.equal(done.body.job.state, "succeeded");
});

/** A valid one-triangle GLB (glTF 2.0 binary). */
function triangleGlb() {
  const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const json = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
  };
  let text = Buffer.from(JSON.stringify(json));
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "latin1"); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]);
}

test("node outputs use the local runner's artifact types: a valid GLB is stored as model3d, a fake GLB is refused", async (t) => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(NODE_OUTPUT_TYPES).map(([ext, type]) => [ext, { ...type }])),
    Object.fromEntries(Object.entries(RENDER_ARTIFACT_TYPES).map(([ext, type]) => [ext, { ...type }])),
    "a node and the local runner file the same outputs the same way",
  );
  const f = await fixture(t);
  const agent = await f.approvedAgent("Desktop");
  const queued = await f.queue(ffmpegJob(["out/model.glb", "out/fake.glb", "out/scene.gltf"]));
  const claim = await f.nodeCall(agent.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } });
  assert.equal(claim.body.job.id, queued.id);
  const { claimId } = claim.body.job;
  const put = (path, bytes) => f.nodeCall(agent.token, "PUT", `/v1/node/jobs/${queued.id}/outputs?claim=${claimId}&path=${encodeURIComponent(path)}`, { body: bytes, headers: { "x-atlas-sha256": sha(bytes) } });

  const glb = triangleGlb();
  const stored = await put("out/model.glb", glb);
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  const record = f.artifacts.get("local", sha(glb));
  assert.equal(record.kind, "model3d");
  assert.equal(record.mediaType, "model/gltf-binary");
  assert.deepEqual(record.provenance, { runId: queued.id, step: "render", source: "atlas-node" });

  // Starts with "glTF" and its sha256 matches, but the header's length is a lie: the store's sniffing refuses it.
  const fake = triangleGlb(); fake.writeUInt32LE(fake.length + 64, 8);
  const refused = await put("out/fake.glb", fake);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "CONTENT_MISMATCH");
  assert.equal(f.artifacts.get("local", sha(fake)), null, "refused bytes never reach the artifact store");
  // JSON that is not a glTF document is refused as .gltf, too.
  const notGltf = Buffer.from(JSON.stringify({ meshes: [] }));
  assert.equal((await put("out/scene.gltf", notGltf)).body.code, "CONTENT_MISMATCH");
  const gltf = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] }));
  assert.equal((await put("out/scene.gltf", gltf)).status, 201);
  assert.equal(f.artifacts.get("local", sha(gltf)).mediaType, "model/gltf+json");
  // The job cannot complete while an output was refused.
  const early = await f.nodeCall(agent.token, "POST", `/v1/node/jobs/${queued.id}/complete`, { json: { claimId, files: [{ path: "out/model.glb", sha256: sha(glb) }, { path: "out/fake.glb", sha256: sha(fake) }, { path: "out/scene.gltf", sha256: sha(gltf) }] } });
  assert.equal(early.body.code, "OUTPUT_MISSING");
});

test("an output bigger than the job allows is refused before it is read", async (t) => {
  const f = await fixture(t);
  const agent = await f.approvedAgent("Laptop");
  const queued = await f.queue({ ...ffmpegJob(), maxOutputBytes: 16 });
  const { body } = await f.nodeCall(agent.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } });
  const refused = await f.nodeCall(agent.token, "PUT", `/v1/node/jobs/${queued.id}/outputs?claim=${body.job.claimId}&path=out%2Fclip.mp4`, { body: MP4, headers: { "x-atlas-sha256": sha(MP4) } });
  assert.equal(refused.status, 413);
});

// ---------------------------------------------------------------------------
// Revocation, lease expiry, single claimant
// ---------------------------------------------------------------------------

test("a node revoked mid-job is rejected, its job goes to another node, and only that node's output counts", async (t) => {
  const f = await fixture(t);
  let revokeNow;
  const container = containerStandIn({ beforeExit: async () => { await revokeNow(); } });
  const laptop = await f.approvedAgent("Laptop", { container });
  revokeNow = async () => { assert.equal((await f.revoke(laptop.nodeId)).status, 200); };
  const desktop = await f.approvedAgent("Desktop");
  const queued = await f.queue();

  const first = await laptop.runOnce({ waitMs: 0 });
  assert.equal(first.claimed, true);
  assert.equal(first.status, "lost", "the revoked node's upload was rejected");
  assert.equal(f.artifacts.list("local").length, 0);
  const requeued = f.nodes.getJob("local", queued.id);
  assert.equal(requeued.state, "queued");
  assert.equal(requeued.attempts, 1);

  assert.equal((await f.nodeCall(laptop.token, "POST", "/v1/node/heartbeat", { json: {} })).status, 401, "the token is dead");
  assert.equal((await f.nodeCall(laptop.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } })).status, 401);

  const second = await desktop.runOnce({ waitMs: 0 });
  assert.equal(second.status, "succeeded");
  const done = f.nodes.getJob("local", queued.id);
  assert.equal(done.state, "succeeded");
  assert.equal(f.nodes.jobEvents("local", queued.id).filter((e) => e.action === "succeeded").length, 1);
  const listed = await f.ownerCall("GET", "/v1/nodes");
  assert.equal(listed.body.nodes.find((n) => n.id === laptop.nodeId).status, "revoked");
});

test("missed heartbeats expire the lease; the job is retried on another node once, then fails, never a third time", async (t) => {
  const f = await fixture(t);
  const a = await f.approvedAgent("A");
  const b = await f.approvedAgent("B");
  const c = await f.approvedAgent("C");
  const job = nodeRenderJob({ id: "job-retry", render: ffmpegJob() });
  const running = runNodeRender({ manager: f.manager, provider: f.nodeProvider, tenantId: "local", taskId: "task-1", job });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const [queued] = f.nodes.listJobs("local");

  const claimA = await f.nodeCall(a.token, "POST", "/v1/node/claim", { json: { waitMs: 2_000 } });
  assert.equal(claimA.body.job.id, queued.id);
  // Heartbeats keep the claim alive past its first expiry.
  f.clock.advance(CLAIM_TTL_MS - 1_000);
  await a.heartbeat();
  f.clock.advance(CLAIM_TTL_MS - 1_000);
  assert.equal(f.nodes.getJob("local", queued.id).state, "claimed", "a heartbeating node keeps its claim");

  // A stops heartbeating.
  f.clock.advance(CLAIM_TTL_MS + 1);
  await b.heartbeat(); await c.heartbeat();
  f.nodes.sweep();
  assert.equal(f.nodes.getJob("local", queued.id).state, "queued", "the lease expired and the job was re-queued");
  assert.equal((await f.nodeCall(a.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } })).body.job, null, "the node that lost it is not handed it again");
  const lateA = await f.nodeCall(a.token, "PUT", `/v1/node/jobs/${queued.id}/outputs?claim=${claimA.body.job.claimId}&path=out%2Fclip.mp4`, { body: MP4, headers: { "x-atlas-sha256": sha(MP4) } });
  assert.equal(lateA.status, 409, "a lost claim cannot upload");

  const claimB = await f.nodeCall(b.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } });
  assert.equal(claimB.body.job.attempt, 2);
  f.clock.advance(CLAIM_TTL_MS + 1);
  await c.heartbeat();
  const claimC = await f.nodeCall(c.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } });
  assert.equal(claimC.body.job, null, "no third attempt");
  assert.equal(f.nodes.getJob("local", queued.id).state, "failed");

  const result = await running;
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "NODE_JOB_FAILED");
  assert.equal(f.manager.getLease("local", result.leaseId).state, "settled", "the lease was ended and settled");
  assert.equal(f.nodes.jobEvents("local", queued.id).filter((e) => e.action === "claimed").length, 2);
});

test("two nodes never both complete the same job", async (t) => {
  const f = await fixture(t);
  const a = await f.approvedAgent("A");
  const b = await f.approvedAgent("B");
  const queued = await f.queue();
  const [ca, cb] = await Promise.all([a, b].map((n) => f.nodeCall(n.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } })));
  const winners = [ca, cb].filter((c) => c.body.job);
  assert.equal(winners.length, 1, "exactly one claimant");
  const [first, second] = ca.body.job ? [a, b] : [b, a];
  const firstClaim = (ca.body.job ?? cb.body.job).claimId;

  // The first claimant uploads, then goes silent; its lease expires and the other node takes over.
  const path = `/v1/node/jobs/${queued.id}/outputs?path=out%2Fclip.mp4&claim=`;
  assert.equal((await f.nodeCall(first.token, "PUT", path + firstClaim, { body: MP4, headers: { "x-atlas-sha256": sha(MP4) } })).status, 201);
  f.clock.advance(CLAIM_TTL_MS + 1);
  await second.heartbeat();
  const takeover = await f.nodeCall(second.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } });
  assert.equal(takeover.body.job.id, queued.id);

  // The first node's completion, with its now-stale claim, is refused.
  const stale = await f.nodeCall(first.token, "POST", `/v1/node/jobs/${queued.id}/complete`, { json: { claimId: firstClaim, files: [{ path: "out/clip.mp4", sha256: sha(MP4) }] } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "CLAIM_LOST");
  // Its earlier upload does not count for the new claim either.
  const premature = await f.nodeCall(second.token, "POST", `/v1/node/jobs/${queued.id}/complete`, { json: { claimId: takeover.body.job.claimId, files: [{ path: "out/clip.mp4", sha256: sha(MP4) }] } });
  assert.equal(premature.body.code, "OUTPUT_MISSING");

  assert.equal((await f.nodeCall(second.token, "PUT", path + takeover.body.job.claimId, { body: MP4, headers: { "x-atlas-sha256": sha(MP4) } })).status, 201);
  const done = await f.nodeCall(second.token, "POST", `/v1/node/jobs/${queued.id}/complete`, { json: { claimId: takeover.body.job.claimId, files: [{ path: "out/clip.mp4", sha256: sha(MP4) }] } });
  assert.equal(done.body.job.state, "succeeded");

  // After a confirmed upload the job is never re-queued, whatever happens to the lease.
  f.clock.advance(10 * CLAIM_TTL_MS);
  f.nodes.sweep();
  assert.equal(f.nodes.getJob("local", queued.id).state, "succeeded");
  const again = await f.nodeCall(first.token, "POST", `/v1/node/jobs/${queued.id}/complete`, { json: { claimId: firstClaim, files: [{ path: "out/clip.mp4", sha256: sha(MP4) }] } });
  assert.equal(again.status, 409);
  assert.equal(f.nodes.jobEvents("local", queued.id).filter((e) => e.action === "succeeded").length, 1);
});

// ---------------------------------------------------------------------------
// Capabilities and tenancy
// ---------------------------------------------------------------------------

test("a node without the needed capability never claims the job", async (t) => {
  const f = await fixture(t);
  const ffmpegOnly = await f.approvedAgent("ffmpeg-only");
  const blender = buildBlenderJob({ scene: "a.blend", output: "out/f", frame: 1 });
  const workspace = join(f.root, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.blend"), "BLENDER");
  const blenderJob = await f.queue(blender, { workspace });
  const gpuJob = await f.queue(ffmpegJob(), { minVramGb: 8 });
  const bigJob = await f.queue(ffmpegJob(), { cpu: { minCores: 64 } });

  const outcome = await ffmpegOnly.runOnce({ waitMs: 0 });
  assert.equal(outcome.claimed, false);
  for (const job of [blenderJob, gpuJob, bigJob]) assert.equal(f.nodes.getJob("local", job.id).state, "queued");
  assert.equal(ffmpegOnly.container.runs.length, 0);
  assert.equal(await f.nodeProvider.estimate({ id: "x", tenantId: "local", render: blender, minVramGb: 0 }), null, "the provider offers no node for it");
  assert.equal(await f.nodeProvider.estimate({ id: "x", tenantId: "local", render: ffmpegJob(), minVramGb: 8 }), null);
  assert.deepEqual(await f.nodeProvider.estimate({ id: "x", tenantId: "local", render: ffmpegJob(), minVramGb: 0 }), { gpuType: "atlas-node", estHourlyUsd: 0, estMinutes: 10 });

  // A GPU node takes the GPU job; GPU is a bonus capability, not a requirement for CPU work.
  const gpuNode = await f.approvedAgent("gpu-box", { detectHardwareImpl: async () => ({ cpuCount: 16, totalMemoryGiB: 64, gpus: [{ vendor: "nvidia", name: "RTX", memoryGiB: 12 }] }) });
  const gpuOutcome = await gpuNode.runOnce({ waitMs: 0 });
  assert.equal(gpuOutcome.jobId, gpuJob.id);
  assert.equal(gpuOutcome.status, "succeeded");

  // Defence in depth: handed a job it cannot run, the node itself declines it.
  const declined = await ffmpegOnly.execute({ id: blenderJob.id, claimId: "0".repeat(32), render: blender, inputs: [], requirements: { terminal: "container", render: ["blender"] } });
  assert.equal(declined.status, "declined");
  assert.equal(ffmpegOnly.container.runs.length, 0);
});

test("nodes are tenant-scoped: another tenant's node never sees this tenant's jobs", async (t) => {
  const f = await fixture(t);
  const { node, token } = f.nodes.createNode({ tenantId: "other", name: "Other", by: LOCAL_OWNER_ID });
  const agent = f.agent(token);
  await agent.register();
  f.nodes.approve("other", node.id, { approver: LOCAL_OWNER_ID });
  const queued = await f.queue();
  const outcome = await agent.runOnce({ waitMs: 0 });
  assert.equal(outcome.claimed, false);
  assert.equal(f.nodes.getJob("local", queued.id).state, "queued");
  assert.equal(f.nodes.getJob("other", queued.id), null);
  assert.throws(() => f.nodes.createNode({ tenantId: "local", name: "x", by: "device:phone" }), { code: "NOT_OWNER" });
});

// ---------------------------------------------------------------------------
// Default provider and the reconciler
// ---------------------------------------------------------------------------

test("nodes are the default provider; with a paid provider configured, a $0 node still wins and the paid one takes the rest", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(defaultComputeProviders({ nodeProvider: f.nodeProvider }).map((p) => p.name), ["atlas-node"]);
  const paid = new FakeGpuProvider({ clock: f.clock });
  const manager = new ComputeManager({ store: f.platform, leaseDb: ":memory:", providers: defaultComputeProviders({ nodeProvider: f.nodeProvider, paid: [paid] }), clock: f.clock });
  await f.approvedAgent("Laptop");
  const cpuPlan = await manager.plan(nodeRenderJob({ id: "cpu", render: ffmpegJob() }), { tenantId: "local" });
  assert.equal(cpuPlan.choice.provider, "atlas-node");
  assert.equal(cpuPlan.choice.estMicroUsd, 0);
  const gpuPlan = await manager.plan(nodeRenderJob({ id: "gpu", render: ffmpegJob(), gpu: { minVramGb: 16 } }), { tenantId: "local" });
  assert.equal(gpuPlan.choice.provider, "fake", "no node has a 16 GB GPU, so the paid provider is chosen (and budgeted as before)");
});

test("the reconciler ends a node lease whose daemon-side heartbeats stopped and cancels the node job", async (t) => {
  const f = await fixture(t);
  const agent = await f.approvedAgent("Laptop");
  const started = await f.manager.start({ tenantId: "local", taskId: "task-1", job: nodeRenderJob({ id: "orphan", render: ffmpegJob() }) });
  const claim = await f.nodeCall(agent.token, "POST", "/v1/node/claim", { json: { waitMs: 0 } });
  assert.equal(claim.body.job.id, started.instance.id);
  f.clock.advance(121_000); // past the compute lease's idle timeout; nobody called manager.heartbeat
  await agent.heartbeat();
  const report = await f.manager.reconcile();
  assert.equal(report.ended[0]?.reason, "idle");
  assert.equal(started.signal.aborted, true);
  assert.equal(f.nodes.getJob("local", started.instance.id).state, "cancelled");
  const late = await f.nodeCall(agent.token, "POST", `/v1/node/jobs/${started.instance.id}/status`, { json: { claimId: claim.body.job.claimId } });
  assert.equal(late.status, 409, "the node learns its job was cancelled");
  assert.deepEqual(await f.nodeProvider.listTagged("atlas"), []);
});
