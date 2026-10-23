import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { LOCAL_UI_CSS, LOCAL_UI_HTML, LOCAL_UI_JS } from "../src/ui.mjs";
import { ArtifactStore } from "../src/platform/artifacts/index.mjs";
import { RENDER_ARTIFACT_TYPES, RenderRunner } from "../src/platform/render/index.mjs";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor } from "../src/platform/genesis/executor.mjs";
import { PlatformTaskStore } from "../src/platform/index.mjs";
import { createComputeService } from "../src/platform/compute/index.mjs";
import { LOCAL_OWNER_ID, NodeProvider, NodeService } from "../src/platform/nodes/index.mjs";
import { AutomationService, AutomationStore } from "../src/platform/automations/service.mjs";
import { BusinessService } from "../src/agent/business-service.mjs";
import { MissionService } from "../src/agent/mission-service.mjs";
import { BUDGET_DIMENSIONS } from "../src/agent/budget.mjs";

/**
 * Console wiring: features that existed in the daemon but were not reachable
 * from the console. Each is driven through the daemon's real HTTP handler and
 * temp SQLite stores; the console's pure blocks are evaluated exactly as the
 * browser runs them. A real-browser pass runs when ATLAS_TEST_PLAYWRIGHT is set.
 */
const TOKEN = "console-wiring-owner-token-0123456789abcdefghijkl";
const PHONE_TOKEN = "console-wiring-phone-token-0123456789abcdefghijkl";
const RUNPOD_KEY = "rp_SECRET_test_key_must_never_leave_the_vault_0123456789";
const owner = { authorization: `Bearer ${TOKEN}` };
const phone = { authorization: `Bearer ${PHONE_TOKEN}` };
const SANDBOX = Object.freeze({ runtime: "/usr/bin/docker", image: "node:22-bookworm-slim", cpus: 1, memoryBytes: 512 * 1024 ** 2, pidsLimit: 64, tmpfsBytes: 16 * 1024 ** 2 });
const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } }).trim();

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
const GLTF = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] }));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16, 3)]);

/** A console block between two markers, plus the helpers it uses, evaluated as the browser would. */
function consoleBlock(startMarker, endMarker, names) {
  const line = (prefix) => {
    const start = LOCAL_UI_JS.indexOf(prefix);
    assert.ok(start >= 0, `console defines ${prefix}`);
    return LOCAL_UI_JS.slice(start, LOCAL_UI_JS.indexOf("\n", start));
  };
  const start = LOCAL_UI_JS.indexOf(startMarker);
  const end = LOCAL_UI_JS.indexOf(endMarker);
  assert.ok(start > 0 && end > start, `${startMarker} block exists`);
  const esc = "function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}";
  return new Function(`${esc}\n${line("const pill=")}\n${line("const when=")}\n${LOCAL_UI_JS.slice(start, end)}\nreturn { ${names.join(", ")} };`)();
}
const businessUi = () => consoleBlock("/* Business review automation (pure)", "/* Business review automation (DOM)", ["businessReviewAction", "automationActionText"]);
const snapshotUi = () => consoleBlock("/* Snapshot panel (pure)", "/* Snapshot panel (DOM)", ["snapshotPanelHtml", "restoreResultHtml", "RESTORE_REFUSALS"]);
const computeUi = () => consoleBlock("/* Compute card (pure)", "/* Compute card (DOM)", ["computeCardHtml"]);

/** A container runtime stand-in that writes each declared output with bytes for its extension. */
function containerStandIn(bytesFor) {
  const runs = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    const staging = /source=(.*),target=\/workspace$/u.exec(args[args.indexOf("--mount") + 1] ?? "")?.[1];
    runs.push({ file, args });
    setImmediate(() => {
      for (const out of args.filter((a) => /^out\//u.test(a))) {
        const target = join(staging, ...out.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytesFor(out));
      }
      child.emit("close", 0, null);
    });
    return child;
  };
  return { spawn, runs };
}

/** A small git workspace for a Genesis project inside `<root>/projects`. */
function smallWorkspace(root) {
  const folder = join(root, "projects", "site");
  mkdirSync(join(folder, "src"), { recursive: true });
  gitIn(folder, "init", "-q", "-b", "main");
  writeFileSync(join(folder, "src", "app.mjs"), "export const answer = () => 42;\n");
  writeFileSync(join(folder, "index.html"), "<h1>Roofing</h1>\n");
  gitIn(folder, "add", "-A");
  gitIn(folder, "commit", "-q", "-m", "init");
  return folder;
}

async function daemon(t, { env = {}, withNodes = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-console-wiring-"));
  const local = new LocalTaskStore(join(root, "local.sqlite"));
  local.addDevice("Phone", createHash("sha256").update(PHONE_TOKEN).digest("hex"));
  const artifacts = new ArtifactStore({ root: join(root, "artifacts") });
  const genesisStore = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store: genesisStore, policy: () => ({ decision: "allow" }) });
  const executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
  const platformStore = new PlatformTaskStore(join(root, "platform.sqlite"));
  const nodes = withNodes ? new NodeService({ db: join(root, "nodes.sqlite"), artifacts, root: join(root, "node-data"), isOwner: ({ userId }) => userId === LOCAL_OWNER_ID }) : null;
  const compute = await createComputeService({
    env, credentials: async (name) => (name === "ATLAS_RUNPOD_API_KEY" ? RUNPOD_KEY : null), store: platformStore,
    leaseDb: join(root, "compute.sqlite"), fetchImpl: async () => { throw new Error("no network in tests"); },
    freeProviders: nodes ? [new NodeProvider({ service: nodes })] : [],
  });
  const tasks = new LocalTaskStore(join(root, "missions.sqlite"));
  const missions = new MissionService({ store: tasks, execute: async () => ({ evidence: [] }) });
  const businessService = new BusinessService({ filename: join(root, "business.sqlite"), missionService: missions });
  const automationStore = new AutomationStore(join(root, "automations.sqlite"));
  const automations = new AutomationService({ store: automationStore, missionService: missions, businessService });
  const container = containerStandIn((out) => ({ ".glb": triangleGlb(), ".gltf": GLTF, ".png": PNG, ".jpg": JPEG, ".webp": WEBP })[out.slice(out.lastIndexOf("."))] ?? Buffer.from("plain"));
  const render = new RenderRunner({ container: { runtime: SANDBOX.runtime }, resolveSandbox: () => SANDBOX, images: { ffmpeg: "atlas/render:test" }, spawn: container.spawn, killContainer: () => true, knownSecrets: [], artifactStore: artifacts });
  const server = createLocalControlServer({
    store: local, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), genesis, genesisCreation: { executor }, artifacts, render,
    compute, nodes, businessService, automations, discoverModels: async () => ({ models: ["local-model"] }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    automations.stop?.();
    compute.close?.();
    for (const closable of [local, artifacts, genesisStore, platformStore, nodes, businessService, automationStore, tasks]) closable?.close?.();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { headers = owner, body } = {}) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { root, origin, call, genesis, genesisStore, executor, compute, nodes, businessService, automations, artifacts, container };
}

/** A Genesis project with a workspace and one verified snapshot, then stopped (failed) so it can be restored. */
async function projectWithSnapshot(h) {
  const created = await h.genesis.create("Build a website for my roofing company");
  const workspace = smallWorkspace(h.root);
  h.genesisStore.transition("local", created.id, "scaffolding", { reason: "test workspace", patch: { workspace } });
  h.genesisStore.transition("local", created.id, "building", { reason: "building" });
  const record = await h.executor.environments.checkpoint(h.genesis.view(created.id));
  assert.ok(record?.snapshot?.treeDigest, "a snapshot was taken");
  h.genesisStore.transition("local", created.id, "failed", { reason: "stopped for the test" });
  return { id: created.id, workspace, record };
}

/** Rewrites the stored tree digest so restoring the snapshot fails closed. */
function tamperTreeDigest(root, projectId) {
  const db = new DatabaseSync(join(root, "genesis.sqlite"));
  const row = db.prepare("SELECT seq, snapshot_json FROM genesis_snapshots WHERE project_id = ? ORDER BY seq DESC LIMIT 1").get(projectId);
  const forged = JSON.parse(row.snapshot_json);
  forged.treeDigest = `sha256:${"0".repeat(64)}`;
  db.prepare("UPDATE genesis_snapshots SET snapshot_json = ? WHERE seq = ?").run(JSON.stringify(forged), row.seq);
  db.close();
}

// ---------------------------------------------------------------------------
// 1. Business reviews
// ---------------------------------------------------------------------------

test("the console links the Businesses page, and the daemon serves it", async (t) => {
  assert.match(LOCAL_UI_HTML, /<a href="\/businesses" id="nav-businesses">/u);
  assert.doesNotMatch(LOCAL_UI_HTML, /<script(?![^>]*src=)/u, "no inline script");
  assert.doesNotThrow(() => new Function(LOCAL_UI_JS));
  const h = await daemon(t);
  const page = await fetch(`${h.origin}/businesses`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/u);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self';/u);
});

test("the automation form offers a business review and builds exactly the documented body, refusing what the daemon refuses", () => {
  assert.match(LOCAL_UI_HTML, /<option value="business-review">Prepare a business review when it is due<\/option>/u);
  for (const id of ["auto-business", "auto-responsibility", "auto-budget-input", "auto-budget-output", "auto-budget-tools", "auto-budget-minutes", "auto-budget-usd"]) assert.ok(LOCAL_UI_HTML.includes(`id="${id}"`), id);
  const { businessReviewAction, automationActionText } = businessUi();
  const fields = { businessId: "biz-1", responsibilityId: "resp-1", repository: " C:/work/business ", model: "local-model", inputTokens: "100000", outputTokens: "20000", toolCalls: "40", minutes: "10", usd: "0.10" };
  // The body docs/BUSINESS-REVIEWS.md gives for POST /v1/automations.
  assert.deepEqual(businessReviewAction(fields).action, {
    kind: "business-review", businessId: "biz-1", responsibilityId: "resp-1", repository: "C:/work/business", model: "local-model",
    budget: { inputTokens: 100000, outputTokens: 20000, toolCalls: 40, elapsedMs: 600000, costMicroUsd: 100000 },
  });
  assert.deepEqual(Object.keys(businessReviewAction(fields).action.budget).sort(), [...BUDGET_DIMENSIONS].sort(), "all five budget dimensions");
  const refusals = [
    [{ businessId: "" }, /business/u], [{ businessId: "../other" }, /business/u], [{ responsibilityId: "Resp One" }, /responsibility/u],
    [{ repository: "  " }, /repository/u], [{ model: "" }, /model/u], [{ inputTokens: "-1" }, /Input tokens/u], [{ toolCalls: "1.5" }, /Tool calls/u],
    [{ minutes: "" }, /Time/u], [{ usd: "-0.5" }, /Spend/u], [{ usd: "abc" }, /Spend/u], [{ outputTokens: "99999999999999999999" }, /too large/u],
  ];
  for (const [change, pattern] of refusals) {
    const result = businessReviewAction({ ...fields, ...change });
    assert.equal(result.action, undefined, JSON.stringify(change));
    assert.match(result.error, pattern);
  }
  assert.equal(automationActionText({ kind: "business-review" }), "Business review");
  assert.equal(automationActionText({ kind: "mission", tasks: ["a", "b"] }), "2 coding task(s)");
  assert.equal(automationActionText({ kind: "team", goal: "x" }), "Team goal");
});

test("a business review automation built by the console is accepted over HTTP for the owner and refused for a paired device", async (t) => {
  const h = await daemon(t);
  const amounts = Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, 10_000_000]));
  const business = h.businessService.create({ name: "Builder", objective: "Prepare lead review", budget: amounts });
  const responsibility = h.businessService.assign(business.id, { owner: "owner", objective: "Review inquiry workflow", successCriteria: ["Document failure handling"], intervalMs: 60_000 });
  // What the form lists comes from these routes.
  const listed = await h.call("GET", "/v1/businesses");
  assert.deepEqual(listed.body.businesses.map((b) => b.id), [business.id]);
  const detail = await h.call("GET", `/v1/businesses/${business.id}`);
  assert.deepEqual(detail.body.business.responsibilities.map((r) => r.id), [responsibility.id]);

  const { businessReviewAction } = businessUi();
  const { action } = businessReviewAction({ businessId: business.id, responsibilityId: responsibility.id, repository: "C:/work/business", model: "local-model", inputTokens: "100000", outputTokens: "20000", toolCalls: "40", minutes: "10", usd: "0.10" });
  const body = { name: "Prepare inquiry workflow review", trigger: { kind: "schedule", cron: "0 9 * * *" }, maxRunsPerDay: 1, action };
  const refused = await h.call("POST", "/v1/automations", { headers: phone, body });
  assert.equal(refused.status, 403);
  const created = await h.call("POST", "/v1/automations", { body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { automations } = (await h.call("GET", "/v1/automations")).body;
  assert.equal(automations.length, 1);
  assert.equal(automations[0].action.kind, "business-review");
  assert.deepEqual(automations[0].action.budget, action.budget);
  // The daemon applies the same strict check the console mirrors.
  const extra = await h.call("POST", "/v1/automations", { body: { ...body, action: { ...action, role: "admin" } } });
  assert.equal(extra.status, 400);
});

// ---------------------------------------------------------------------------
// 2. Genesis snapshot receipt and restore
// ---------------------------------------------------------------------------

test("the Build page shows the latest snapshot receipt and restores it over HTTP with a verified receipt", async (t) => {
  assert.ok(LOCAL_UI_HTML.includes('<section id="build-snapshot" class="panel" hidden aria-labelledby="build-snapshot-heading">'));
  assert.ok(LOCAL_UI_JS.includes("loadSnapshotPanel(v)"), "the project page draws the panel");
  assert.ok(LOCAL_UI_JS.includes("if(view!=='build')clearSnapshotPanel()"), "leaving Build clears it");
  const h = await daemon(t);
  const p = await projectWithSnapshot(h);
  const ui = snapshotUi();

  const receipt = await h.call("GET", `/v1/genesis/${p.id}/snapshot`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.snapshot.treeDigest, p.record.snapshot.treeDigest);
  assert.equal(receipt.body.snapshot.state, "building");
  assert.equal(receipt.body.lastRestore, null);
  assert.equal(receipt.body.restorable, true);
  const html = ui.snapshotPanelHtml({ receipt: receipt.body, role: "owner" });
  assert.ok(html.includes(p.record.snapshot.treeDigest.replace(/^sha256:/u, "").slice(0, 12)), "the digest is shown");
  assert.match(html, /Not restored yet/u);
  assert.match(html, /<button type="button" class="secondary" id="restore-start">Restore last snapshot<\/button>/u);
  assert.doesNotMatch(html, /id="restore-go"/u, "nothing restores without the confirm step");
  const confirm = ui.snapshotPanelHtml({ receipt: receipt.body, role: "owner", confirming: true });
  assert.match(confirm, /id="restore-confirm"/u);
  assert.match(confirm, /<button type="button" id="restore-go">Restore now<\/button>/u);
  assert.match(confirm, /The current folder is kept/u);

  // A POST to the read-only receipt route never reaches the action chain (which would cancel).
  assert.equal((await h.call("POST", `/v1/genesis/${p.id}/snapshot`, { body: {} })).status, 405);
  assert.equal(h.genesis.view(p.id).state, "failed");

  // A paired device sees the receipt but cannot restore.
  const device = await h.call("GET", `/v1/genesis/${p.id}/snapshot`, { headers: phone });
  assert.equal(device.status, 200);
  assert.match(ui.snapshotPanelHtml({ receipt: device.body, role: "device" }), /id="restore-owner-only"/u);
  assert.equal((await h.call("POST", `/v1/genesis/${p.id}/restore`, { headers: phone, body: {} })).status, 403);

  const restored = await h.call("POST", `/v1/genesis/${p.id}/restore`, { body: {} });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.restore.verified, true);
  assert.equal(restored.body.project.state, "building");
  const result = ui.restoreResultHtml(restored.status, restored.body);
  assert.match(result, /Restored and verified/u);
  assert.ok(result.includes(p.workspace), "the previous folder is named");

  const after = (await h.call("GET", `/v1/genesis/${p.id}/snapshot`)).body;
  assert.equal(after.lastRestore.verified, true);
  assert.equal(after.lastRestore.snapshot, p.record.snapshot.id);
  assert.match(ui.snapshotPanelHtml({ receipt: after, role: "owner" }), /Verified when it was restored/u);
  assert.equal(after.restorable, false, "a building project is not restorable");
});

test("a tampered snapshot is refused with DIGEST_MISMATCH, nothing changes, and the console says so in plain language", async (t) => {
  const h = await daemon(t);
  const p = await projectWithSnapshot(h);
  tamperTreeDigest(h.root, p.id);
  const refused = await h.call("POST", `/v1/genesis/${p.id}/restore`, { body: {} });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.restore.refused, true);
  assert.equal(refused.body.restore.code, "DIGEST_MISMATCH");
  assert.equal(h.genesis.view(p.id).state, "failed", "the project is left as it was");
  assert.equal(h.genesis.view(p.id).workspace, p.workspace);
  const { restoreResultHtml, RESTORE_REFUSALS } = snapshotUi();
  const html = restoreResultHtml(refused.status, refused.body);
  assert.match(html, /Not restored: the snapshot failed verification \(DIGEST_MISMATCH\)\./u);
  assert.ok(html.includes(RESTORE_REFUSALS.DIGEST_MISMATCH.replaceAll("'", "'")));
  assert.match(html, /Nothing was changed/u);
  // Other refusals and preconditions read as words, not codes.
  assert.match(restoreResultHtml(409, { restore: { restored: false, reason: "no-snapshot" } }), /no snapshot of this project yet/u);
  assert.match(restoreResultHtml(409, { restore: { restored: false, reason: "running" } }), /Pause it first/u);
  assert.match(restoreResultHtml(503, { message: "Restoring projects is not available in this Atlas." }), /not available/u);
});

// ---------------------------------------------------------------------------
// 3. Compute visibility
// ---------------------------------------------------------------------------

test("GET /v1/compute: GPU spending off by default, owner only, and Atlas Nodes are counted", async (t) => {
  const h = await daemon(t);
  const { node, token } = h.nodes.createNode({ tenantId: "local", name: "Desk GPU", by: LOCAL_OWNER_ID });
  h.nodes.createNode({ tenantId: "local", name: "Laptop", by: LOCAL_OWNER_ID });
  const credential = h.nodes.authenticate(token);
  h.nodes.register(credential, { capabilities: { render: ["ffmpeg"], terminal: "container" } });
  h.nodes.approve("local", node.id, { approver: LOCAL_OWNER_ID });
  h.nodes.heartbeat(h.nodes.authenticate(token), {});

  assert.equal((await h.call("GET", "/v1/compute", { headers: phone })).status, 403, "a paired device cannot read spend");
  assert.equal((await h.call("POST", "/v1/compute", { body: {} })).status, 405);
  const { status, body } = await h.call("GET", "/v1/compute");
  assert.equal(status, 200);
  const c = body.compute;
  assert.equal(c.rented, false);
  assert.equal(c.gpuSpending, false);
  assert.equal(c.capMicroUsd, 0);
  assert.deepEqual(c.nodes, { count: 2, approved: 1, online: 1 });
  const ui = computeUi();
  const card = ui.computeCardHtml(status, body);
  assert.match(card.html, /GPU spending off \(cap \$0\.00\)/u);
  assert.match(card.html, /Atlas Nodes: 2 set up, 1 approved, 1 online/u);
  assert.match(ui.computeCardHtml(403, { message: "x" }).html, /Only the owner/u);
});

test("GET /v1/compute with RunPod and a cap shows month-to-date spend and recent leases, never the key", async (t) => {
  const h = await daemon(t, { env: { ATLAS_RUNPOD_ENDPOINT_ID: "endpoint-test", ATLAS_GPU_MONTHLY_CAP_USD: "25" } });
  const now = Date.now();
  h.compute.manager.leases.insert({
    tenantId: "local", id: "lease-1", jobId: "job-1", taskId: "task-1", provider: "runpod", gpuType: "AMPERE_24", holder: "test",
    reservedMicroUsd: 1_250_000, rateMicroUsdPerSec: 190, maxLifetimeSec: 600, idleTimeoutSec: 300, createdAt: now, leaseExpiresAt: now + 300_000, deadlineAt: now + 600_000,
  });
  const { status, body } = await h.call("GET", "/v1/compute");
  assert.equal(status, 200);
  const c = body.compute;
  assert.equal(c.rented, true);
  assert.equal(c.gpuSpending, true);
  assert.equal(c.capMicroUsd, 25_000_000);
  assert.equal(c.spend.totalMicroUsd, 1_250_000);
  assert.equal(c.spend.remainingMicroUsd, 23_750_000);
  assert.deepEqual(c.leases.map((l) => [l.id, l.state, l.reservedMicroUsd]), [["lease-1", "provisioning", 1_250_000]]);
  assert.equal("instanceId" in c.leases[0], false, "only allowlisted lease fields");
  const raw = JSON.stringify(body);
  assert.equal(raw.includes(RUNPOD_KEY), false, "the API key never leaves the vault");
  assert.equal(/apiKey|api_key/iu.test(raw), false);
  assert.match(computeUi().computeCardHtml(status, body).html, /\$1\.25 of \$25\.00 this month/u);
});

test("a daemon without a compute service still answers GET /v1/compute with the reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-console-wiring-bare-"));
  const local = new LocalTaskStore(join(root, "local.sqlite"));
  const server = createLocalControlServer({ store: local, token: TOKEN, runTask: async () => ({ ok: true, message: "" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/compute`, { headers: owner });
    const { compute } = await response.json();
    assert.equal(response.status, 200);
    assert.equal(compute.enabled, false);
    assert.equal(compute.nodes, null);
    assert.match(compute.reason, /not configured/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    local.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Render outputs: models and images become artifacts with their real types
// ---------------------------------------------------------------------------

test("render outputs: .glb/.gltf are stored as model3d and images with their media type; the console's viewers open them", async (t) => {
  const h = await daemon(t);
  const p = await projectWithSnapshot(h);
  const outputs = ["out/model.glb", "out/scene.gltf", "out/frame.png", "out/thumb.jpg", "out/still.webp", "out/notes.txt"];
  const job = { tool: "ffmpeg", args: ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=1", ...outputs], inputs: [], outputs };
  const { status, body } = await h.call("POST", "/v1/render/jobs", { body: { projectId: p.id, job } });
  assert.equal(status, 200, JSON.stringify(body));
  const byPath = Object.fromEntries(body.result.files.map((f) => [f.path, f]));
  const expected = { "out/model.glb": ["model3d", "model/gltf-binary"], "out/scene.gltf": ["model3d", "model/gltf+json"], "out/frame.png": ["file", "image/png"], "out/thumb.jpg": ["file", "image/jpeg"], "out/still.webp": ["file", "image/webp"] };
  for (const [path, [kind, mediaType]] of Object.entries(expected)) {
    const sha = byPath[path].artifact?.sha256;
    assert.ok(sha, `${path} was stored: ${JSON.stringify(byPath[path])}`);
    const { artifact } = (await h.call("GET", `/v1/artifacts/${sha}`)).body;
    assert.equal(artifact.kind, kind, path);
    assert.equal(artifact.mediaType, mediaType, path);
    assert.equal(artifact.provenance.runId, p.id);
    const content = await fetch(`${h.origin}/v1/artifacts/${sha}/content`, { headers: owner });
    assert.equal(content.headers.get("content-type").split(";")[0], mediaType);
  }
  assert.equal(byPath["out/notes.txt"].artifact, undefined, "other types stay in the workspace only");
  assert.deepEqual(Object.keys(RENDER_ARTIFACT_TYPES).sort(), [".glb", ".gltf", ".jpeg", ".jpg", ".mp4", ".png", ".webm", ".webp"]);

  // The console's own glTF reader opens the stored GLB.
  const start = LOCAL_UI_JS.indexOf("function parseGltf(");
  const parseGltf = new Function(`${LOCAL_UI_JS.slice(start, LOCAL_UI_JS.indexOf("function showModel("))}; return parseGltf;`)();
  const glb = Buffer.from(await (await fetch(`${h.origin}/v1/artifacts/${byPath["out/model.glb"].artifact.sha256}/content`, { headers: owner })).arrayBuffer());
  assert.equal(parseGltf(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), "model/gltf-binary").triangles, 1);
  // Images and models take the existing viewer branches.
  assert.ok(LOCAL_UI_JS.includes("else if(a.mediaType.startsWith('image/'))"));
  assert.ok(LOCAL_UI_JS.includes("else if(a.kind==='model3d')"));
});

test("a render output that only claims to be glTF is not stored as a model", async (t) => {
  const h = await daemon(t);
  const p = await projectWithSnapshot(h);
  const bad = triangleGlb(); bad.writeUInt32LE(bad.length + 100, 8);
  h.container.runs.length = 0;
  const fake = containerStandIn((out) => (out.endsWith(".glb") ? bad : Buffer.from("[1,2,3]")));
  const render = new RenderRunner({ container: { runtime: SANDBOX.runtime }, resolveSandbox: () => SANDBOX, images: { ffmpeg: "atlas/render:test" }, spawn: fake.spawn, killContainer: () => true, knownSecrets: [], artifactStore: h.artifacts });
  const outputs = ["out/wrong.glb", "out/wrong.gltf"];
  const result = await render.run(p.workspace, { tool: "ffmpeg", args: ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=1", ...outputs], inputs: [], outputs }, { tenantId: "local", runId: p.id });
  assert.equal(result.ok, true);
  for (const file of result.files) {
    assert.equal(file.artifact, undefined, file.path);
    assert.equal(file.artifactError.code, "CONTENT_MISMATCH", file.path);
  }
});

test("the artifact store's glTF checks are strict: GLB version and length, glTF JSON needs asset.version", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atlas-console-wiring-gltf-"));
  const artifacts = new ArtifactStore({ root });
  t.after(() => { artifacts.close(); rmSync(root, { recursive: true, force: true }); });
  const provenance = { runId: "run-1", step: "render" };
  const put = (mediaType, bytes) => artifacts.put({ tenantId: "local", kind: "model3d", mediaType, provenance, bytes });
  assert.equal((await put("model/gltf-binary", triangleGlb())).created, true);
  const version1 = triangleGlb(); version1.writeUInt32LE(1, 4);
  const longer = Buffer.concat([triangleGlb(), Buffer.alloc(4)]);
  const truncated = triangleGlb().subarray(0, 40);
  const magicOnly = Buffer.from("glTF");
  for (const bytes of [version1, longer, truncated, magicOnly]) await assert.rejects(put("model/gltf-binary", bytes), { code: "CONTENT_MISMATCH" });
  assert.equal((await put("model/gltf+json", GLTF)).created, true);
  for (const text of ["{}", "[1,2]", "{\"asset\":{}}", "{\"asset\":{\"version\":2}}"]) await assert.rejects(put("model/gltf+json", text), { code: "CONTENT_MISMATCH" }, text);
  // The same check applies to files read from disk.
  const file = join(root, "longer.glb"); writeFileSync(file, longer);
  await assert.rejects(artifacts.put({ tenantId: "local", kind: "model3d", mediaType: "model/gltf-binary", provenance, path: file }), { code: "CONTENT_MISMATCH" });
});

test("the console stays under its CSP: new pieces add no inline script or style", () => {
  assert.doesNotMatch(LOCAL_UI_HTML, /<script(?![^>]*src=)/u);
  assert.doesNotMatch(LOCAL_UI_HTML, /\sstyle=/u);
  assert.doesNotMatch(LOCAL_UI_JS, /\sstyle=|\.style\./u);
  assert.doesNotMatch(LOCAL_UI_JS, /\son[a-z]+="/u, "no inline event handlers in generated markup");
  assert.ok(LOCAL_UI_CSS.includes(".auto-limits{"));
});

// ---------------------------------------------------------------------------
// Real browser
// ---------------------------------------------------------------------------

let playwright;
try {
  if (process.env.ATLAS_TEST_PLAYWRIGHT) playwright = await import(pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href);
} catch { /* The dependency-free checks above run everywhere. */ }

test("in a browser: Businesses is in the nav, a business review automation is created, compute spend shows, and a refused restore explains itself", {
  skip: !playwright && "Configure ATLAS_TEST_PLAYWRIGHT for real-browser acceptance", timeout: 120_000,
}, async (t) => {
  const h = await daemon(t);
  const amounts = Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, 10_000_000]));
  const business = h.businessService.create({ name: "Builder", objective: "Prepare lead review", budget: amounts });
  const responsibility = h.businessService.assign(business.id, { owner: "owner", objective: "Review inquiry workflow", successCriteria: ["Done"], intervalMs: 60_000 });
  const p = await projectWithSnapshot(h);
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /Content Security Policy/u.test(message.text())) errors.push(message.text()); });
  await page.goto(`${h.origin}/`);
  await page.evaluate((token) => sessionStorage.setItem("atlas-token", token), TOKEN);

  // Businesses is reachable from the navigation.
  await page.goto(`${h.origin}/#/home`);
  assert.equal(await page.locator("#nav-businesses").getAttribute("href"), "/businesses");

  // Business review automation.
  await page.goto(`${h.origin}/#/automations`);
  await page.reload();
  await page.locator("#automation-new-panel summary").click();
  await page.locator("#auto-name").fill("Prepare inquiry workflow review");
  await page.locator("#auto-kind").selectOption("business-review");
  assert.equal(await page.locator("#auto-text-label").isHidden(), true, "no free-text task for a review");
  await page.locator(`#auto-business option[value="${business.id}"]`).waitFor({ state: "attached" });
  await page.locator("#auto-business").selectOption(business.id);
  await page.locator(`#auto-responsibility option[value="${responsibility.id}"]`).waitFor({ state: "attached" });
  await page.locator("#auto-responsibility").selectOption(responsibility.id);
  await page.locator("#auto-repository").fill("C:/work/business");
  await page.locator("#auto-budget-usd").fill("-1");
  await page.locator("#automation-form button", { hasText: "Create" }).click();
  assert.match(await page.locator("#automations-notice").textContent(), /Spend must be/u, "validated before sending");
  await page.locator("#auto-budget-usd").fill("0.10");
  await page.locator("#automation-form button", { hasText: "Create" }).click();
  await page.waitForFunction(() => document.querySelector("#automations-notice").textContent === "Created.");
  await page.waitForFunction(() => /Business review/.test(document.querySelector("#automations-list").textContent));
  const { automations } = (await h.call("GET", "/v1/automations")).body;
  assert.deepEqual(automations[0].action, { kind: "business-review", businessId: business.id, responsibilityId: responsibility.id, repository: "C:/work/business", model: "local-model", budget: { inputTokens: 100000, outputTokens: 20000, toolCalls: 40, elapsedMs: 600000, costMicroUsd: 100000 } });

  // Compute & spend on the Models page.
  await page.goto(`${h.origin}/#/models`);
  await page.locator("#compute-headline").waitFor();
  assert.match(await page.locator("#compute-headline").textContent(), /GPU spending off \(cap \$0\.00\)/u);
  assert.match(await page.locator("#compute-nodes").textContent(), /Atlas Nodes: 0 set up/u);

  // Restore on the Build page: receipt, confirm step, plain-language refusal.
  tamperTreeDigest(h.root, p.id);
  await page.goto(`${h.origin}/#/build/${p.id}`);
  await page.locator("#snapshot-receipt").waitFor();
  assert.match(await page.locator("#snapshot-verified").textContent(), /Not restored yet/u);
  await page.locator("#restore-start").click();
  await page.locator("#restore-confirm").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), "restore-go", "focus moves to the confirm button");
  // The 5-second Build refresh does not close the confirm step.
  await page.waitForTimeout(5_500);
  assert.equal(await page.locator("#restore-confirm").count(), 1);
  await page.locator("#restore-cancel").click();
  assert.equal(await page.locator("#restore-confirm").count(), 0, "cancel restores nothing");
  await page.locator("#restore-start").click();
  await page.locator("#restore-go").click();
  await page.locator("#restore-refused").waitFor();
  assert.match(await page.locator("#restore-refused").textContent(), /DIGEST_MISMATCH[\s\S]*Nothing was changed/u);
  assert.equal(h.genesis.view(p.id).state, "failed");
  const overflow = await page.evaluate(() => [...document.querySelectorAll("#build-snapshot *, #compute-panel *, #automation-form *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.tagName + "#" + el.id));
  assert.deepEqual(overflow, [], "the new pieces fit a phone screen");
  assert.deepEqual(errors, []);
});
