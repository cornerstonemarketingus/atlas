import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SelfImprovementLoop } from "../src/platform/self-improve/loop.mjs";
import { resolveCheck, runCheck, assertSafeEndpoint } from "../src/platform/self-improve/runtime.mjs";
import { SelfImprovementService, createSelfImproveRoutes } from "../src/platform/self-improve/service.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

function sh(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "atlas-selfsvc-"));
  const repository = join(root, "repo");
  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(join(repository, "tests"), { recursive: true });
  writeFileSync(join(repository, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  writeFileSync(join(repository, "src", "math.mjs"), "export function add(a, b) { return a - b; }\n");
  writeFileSync(join(repository, "tests", "math.test.mjs"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  sh(repository, "init", "-q", "-b", "main");
  sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const service = new SelfImprovementService({
    repository,
    decisionsPath: join(root, "decisions.jsonl"),
    createLoop: ({ log, onOutput }) => new SelfImprovementLoop({
      repository, worktreeRoot: join(root, "worktrees"), ledgerPath: join(root, "ledger.jsonl"), patchesDirectory: join(root, "patches"),
      runCheck, log,
      builder: async ({ worktree }) => { onOutput("coder: fixing add()\n"); writeFileSync(join(worktree, "src", "math.mjs"), "export function add(a, b) { return a + b; }\n"); return { ok: true }; },
      reviewer: async () => ({ approve: true, summary: "Correct.", concerns: [] }),
    }),
  });
  return { root, repository, service };
}

test("a run happens in the background, streams progress, and leaves the change waiting for approval", async () => {
  const { root, repository, service } = setup();
  const started = service.start({ iterations: 1 });
  assert.equal(started.running, true);
  assert.throws(() => service.start({ iterations: 1 }), /already in progress/u);
  await started.promise;
  const status = service.status();
  assert.equal(status.running, false);
  assert.equal(status.streak, 1);
  assert.equal(status.pending.length, 1);
  assert.ok(status.log.some((line) => line.includes("│ coder: fixing add()")));
  assert.ok(status.log.some((line) => line.includes("accepted")));
  // Nothing reached the checkout yet.
  assert.match(readFileSync(join(repository, "src", "math.mjs"), "utf8"), /a - b/u);
  rmSync(root, { recursive: true, force: true });
});

test("approve merges into the owner's branch with a merge commit and removes the agent branch", async () => {
  const { root, repository, service } = setup();
  await service.start().promise;
  const [change] = service.pending();
  const decision = await service.approve(change.id);
  assert.equal(decision.decision, "approved");
  assert.equal(decision.into, "main");
  assert.match(readFileSync(join(repository, "src", "math.mjs"), "utf8"), /a \+ b/u);
  assert.match(sh(repository, "log", "-1", "--pretty=%s"), /Merge Atlas self-improvement/u);
  assert.equal(sh(repository, "branch", "--list", "atlas/*"), "");
  assert.equal(service.pending().length, 0);
  await assert.rejects(service.approve(change.id), /No accepted change/u);
  rmSync(root, { recursive: true, force: true });
});

test("approve refuses a dirty checkout and changes nothing; reject deletes the branch", async () => {
  const { root, repository, service } = setup();
  await service.start().promise;
  const [change] = service.pending();
  writeFileSync(join(repository, "notes.txt"), "work in progress");
  await assert.rejects(service.approve(change.id), (error) => error.code === "DIRTY_CHECKOUT");
  assert.match(readFileSync(join(repository, "src", "math.mjs"), "utf8"), /a - b/u);
  const decision = await service.reject(change.id, "Not now.");
  assert.equal(decision.decision, "rejected");
  assert.equal(sh(repository, "branch", "--list", "atlas/*"), "");
  assert.equal(service.pending().length, 0);
  assert.equal(service.status().decisions[0].reason, "Not now.");
  rmSync(root, { recursive: true, force: true });
});

test("routes: anyone authenticated can read; only the owner can start, approve or reject", async () => {
  const { root, service } = setup();
  const sent = [];
  const send = (_response, status, value) => { sent.push({ status, value }); return true; };
  const parseBody = async (request) => request.body;
  const handle = createSelfImproveRoutes({ service, parseBody, send });
  const request = (method, url, body = {}) => ({ method, url, body });
  assert.equal(await handle(request("GET", "/v1/other"), {}, { role: "admin" }), false);
  await handle(request("GET", "/v1/self-improve"), {}, { role: "device" });
  assert.equal(sent.at(-1).status, 200);
  await handle(request("POST", "/v1/self-improve/runs", { iterations: 1 }), {}, { role: "device" });
  assert.equal(sent.at(-1).status, 403);
  await handle(request("POST", "/v1/self-improve/runs", { iterations: 1 }), {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 202);
  await handle(request("POST", "/v1/self-improve/runs", { iterations: 1 }), {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 409);
  await service.current?.promise;
  await handle(request("POST", "/v1/self-improve/changes/nope/approve"), {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 404);
  const [change] = service.pending();
  await handle(request("POST", `/v1/self-improve/changes/${change.id}/reject`, { reason: "x" }), {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 200);
  rmSync(root, { recursive: true, force: true });
});

test("runtime: node and npm run without a shell on every platform; endpoints must be safe", () => {
  assert.deepEqual(resolveCheck(["node", "--test"], { platform: "linux", execPath: "/usr/bin/node" }), ["/usr/bin/node", ["--test"]]);
  assert.deepEqual(resolveCheck(["npm", "test"], { platform: "linux", execPath: "/usr/bin/node" }), ["npm", ["test"]]);
  assert.throws(() => assertSafeEndpoint("http://models.example.com/v1"), /HTTPS/u);
  assert.throws(() => assertSafeEndpoint("https://user:pw@models.example.com/v1"), /credentials/u);
  assert.ok(assertSafeEndpoint("http://127.0.0.1:11434/v1"));
});

test("approval refuses a branch changed after its exact revision was verified", async () => {
  const { root, repository, service } = setup();
  try {
    await service.start().promise;
    const [change] = service.pending();
    const reviewedHead = change.head;
    const before = sh(repository, "rev-parse", "HEAD");
    const tree = sh(repository, "rev-parse", `${reviewedHead}^{tree}`);
    const replacement = sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-p", reviewedHead, "-m", "Unreviewed replacement");
    sh(repository, "update-ref", `refs/heads/${change.branch}`, replacement);
    await assert.rejects(service.approve(change.id), (error) => error.code === "STALE_CHANGE");
    assert.equal(sh(repository, "rev-parse", "HEAD"), before);
    assert.equal(sh(repository, "rev-parse", change.branch), replacement);
    assert.equal(service.decisions().length, 0);
    assert.equal(service.pending()[0].head, reviewedHead);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval refuses a destination changed since verification without merging or recording success", async () => {
  const { root, repository, service } = setup();
  try {
    await service.start().promise;
    const [change] = service.pending();
    sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "Owner changed base");
    const before = sh(repository, "rev-parse", "HEAD");
    await assert.rejects(service.approve(change.id), (error) => error.code === "STALE_BASE");
    assert.equal(sh(repository, "rev-parse", "HEAD"), before);
    assert.equal(service.decisions().length, 0);
    assert.equal(service.pending().length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent approval and rejection cannot execute two decisions for one change", async () => {
  const { root, repository, service } = setup();
  let approval;
  try {
    await service.start().promise;
    const [change] = service.pending();
    approval = service.approve(change.id);
    await assert.rejects(service.reject(change.id, "Concurrent rejection"), (error) => error.code === "BUSY");
    assert.throws(() => service.start(), (error) => error.code === "BUSY");
    const decision = await approval;
    assert.equal(decision.reviewedHead, change.head);
    assert.equal(decision.reviewedBase, change.base);
    assert.equal(sh(repository, "rev-parse", "HEAD^1"), change.base);
    assert.equal(sh(repository, "rev-parse", "HEAD^2"), change.head);
    assert.equal(service.decisions().length, 1);
  } finally { if (approval) await Promise.allSettled([approval]); rmSync(root, { recursive: true, force: true }); }
});

test("a legacy change without a verified head cannot merge and rejection preserves its branch", async () => {
  const { root, repository, service } = setup();
  try {
    await service.start().promise;
    const [change] = service.pending();
    const legacy = { ...change };
    delete legacy.head;
    writeFileSync(join(root, "ledger.jsonl"), `${JSON.stringify(legacy)}\n`);
    await assert.rejects(service.approve(change.id), (error) => error.code === "UNVERIFIED_CHANGE");
    assert.equal(service.decisions().length, 0);
    const rejected = await service.reject(change.id);
    assert.equal(rejected.branchRetained, true);
    assert.equal(sh(repository, "rev-parse", change.branch), change.head);
    assert.equal(service.pending().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reject records the decision without deleting a moved branch", async () => {
  const { root, repository, service } = setup();
  try {
    await service.start().promise;
    const [change] = service.pending();
    const replacement = sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", `${change.head}^{tree}`, "-p", change.head, "-m", "New work after review");
    sh(repository, "update-ref", `refs/heads/${change.branch}`, replacement);
    const decision = await service.reject(change.id, "Discard reviewed proposal only");
    assert.equal(decision.branchRetained, true);
    assert.equal(sh(repository, "rev-parse", change.branch), replacement);
    assert.equal(service.pending().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approved merges do not execute repository hooks", async () => {
  const { root, repository, service } = setup();
  try {
    await service.start().promise;
    const [change] = service.pending();
    const hooks = join(root, "untrusted-hooks");
    mkdirSync(hooks);
    for (const name of ["pre-merge-commit", "post-merge"]) {
      writeFileSync(join(hooks, name), `#!/bin/sh\nprintf unsafe > .atlas-${name}-executed\n`, { mode: 0o755 });
    }
    sh(repository, "config", "core.hooksPath", hooks);
    await service.approve(change.id);
    assert.equal(existsSync(join(repository, ".atlas-pre-merge-commit-executed")), false);
    assert.equal(existsSync(join(repository, ".atlas-post-merge-executed")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approved merges bypass inherited signing configuration without changing it", async () => {
  const { root, repository, service } = setup();
  try {
    await service.start().promise;
    const [change] = service.pending();
    sh(repository, "config", "commit.gpgsign", "true");
    sh(repository, "config", "gpg.program", join(root, "missing-signing-tool"));
    await service.approve(change.id);
    assert.equal(sh(repository, "config", "commit.gpgsign"), "true");
    assert.equal(sh(repository, "rev-parse", "HEAD^2"), change.head);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real authenticated HTTP refuses stale revisions, approves exact commits and rejects replay after service restart", async () => {
  const { root, repository, service } = setup();
  const store = new LocalTaskStore(join(root, "http.sqlite"));
  const token = "self-improve-test-owner-token-0123456789";
  const server = createLocalControlServer({ store, token, selfImprove: service, runTask: async () => ({ ok: true }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    await service.start().promise;
    const [change] = service.pending();
    const path = `/v1/self-improve/changes/${change.id}/approve`;
    assert.equal((await fetch(`${base}${path}`, { method: "POST", body: "{}" })).status, 401);
    const paired = await fetch(`${base}/v1/pair`, { method: "POST", headers: owner });
    const { code } = await paired.json();
    const claimed = await fetch(`${base}/v1/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Test phone" }) });
    const { deviceToken } = await claimed.json();
    assert.equal((await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: "{}" })).status, 403);
    const replacement = sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", `${change.head}^{tree}`, "-p", change.head, "-m", "Drifted proposal");
    sh(repository, "update-ref", `refs/heads/${change.branch}`, replacement);
    const stale = await fetch(`${base}${path}`, { method: "POST", headers: owner, body: "{}" });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "STALE_CHANGE");
    assert.equal(service.decisions().length, 0);
    sh(repository, "update-ref", `refs/heads/${change.branch}`, change.head, replacement);
    const approved = await fetch(`${base}${path}`, { method: "POST", headers: owner, body: "{}" });
    assert.equal(approved.status, 200);
    const { decision } = await approved.json();
    assert.equal(decision.reviewedHead, change.head);
    assert.equal(decision.reviewedBase, change.base);
    assert.equal(decision.branchRetained, false);
    assert.equal(sh(repository, "rev-parse", "HEAD^2"), change.head);
    assert.equal((await fetch(`${base}${path}`, { method: "POST", headers: owner, body: "{}" })).status, 404);
    const restored = new SelfImprovementService({ repository, decisionsPath: join(root, "decisions.jsonl"), createLoop: () => service.loop });
    assert.equal(restored.pending().length, 0);
    assert.equal(restored.decisions()[0].reviewedHead, change.head);
    await assert.rejects(restored.approve(change.id), (error) => error.code === "UNKNOWN_CHANGE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
