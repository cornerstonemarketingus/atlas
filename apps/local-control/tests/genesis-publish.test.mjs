import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisPublisher, PublishError, assertRemote, publishDigest, pushMain } from "../src/platform/genesis/publish.mjs";
import { commitWorkspace, createWorkspace } from "../src/platform/genesis/workspace.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const REMOTE = "https://github.com/owner/lead-tracker.git";

async function readyProject(root, { file = join(root, "genesis.sqlite") } = {}) {
  const store = new GenesisStore(file);
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const project = await genesis.create("Build a REST API for managing inventory items");
  const workspace = await createWorkspace({ root: join(root, "projects"), projectId: project.id, spec: project.spec, templateId: project.plan.template });
  genesis.advance(project.id, "scaffolding", { reason: "s" });
  genesis.advance(project.id, "building", { reason: "b", patch: { workspace: workspace.folder } });
  for (const to of ["verifying", "previewing", "reviewing", "ready"]) genesis.advance(project.id, to, { reason: to });
  return { store, genesis, project: genesis.view(project.id) };
}

function fakeApprovals(decision) {
  const created = [];
  return { created, policy: () => ({ decision }), create: (request) => { const approval = { id: `appr-${created.length + 1}`, status: "pending", ...request }; created.push(approval); return approval; }, get: (id) => created.find((a) => a.id === id) ?? null };
}

const withRoot = async (run) => {
  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-publish-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
};

test("remotes are validated and carry no credentials", () => {
  for (const good of [REMOTE, "git@github.com:owner/app.git", "https://gitlab.example.com/group/sub/app", "ssh://git@forgejo.example.com:2222/me/app.git"]) assert.equal(assertRemote(good), good);
  for (const bad of ["https://user:pass@github.com/o/a.git", "http://github.com/o/a.git", "/tmp/repo", "file:///tmp/repo", "--upload-pack=evil", "https://github.com/o/a.git; rm -rf /"]) assert.throws(() => assertRemote(bad), PublishError, bad);
});

test("publishing asks through the approvals system and only publishes the approved commit", () => withRoot(async (root) => {
  const { store, genesis, project } = await readyProject(root);
  const pushes = [];
  const approvals = fakeApprovals("ask");
  const publisher = new GenesisPublisher({ genesis, approvals, push: async (folder, remote) => { pushes.push(remote); return { ok: true, message: "pushed" }; } });
  const requested = await publisher.request(project.id, { remote: REMOTE });
  assert.equal(requested.status, "awaiting-approval");
  assert.equal(approvals.created[0].capability, "publish.remote");
  assert.match(approvals.created[0].summary, /Publish "Item API"/u);
  assert.equal(approvals.created[0].actionDigest, publishDigest({ projectId: project.id, remote: REMOTE, commit: requested.commit }));
  assert.equal(genesis.view(project.id).state, "ready", "nothing happens before the owner decides");
  assert.deepEqual(pushes, []);

  // A restarted Atlas (new publisher, same store) still acts on the decision.
  const restarted = new GenesisPublisher({ genesis, approvals, push: async (folder, remote) => { pushes.push(remote); return { ok: true, message: "pushed" }; } });
  const result = await restarted.onApprovalDecided({ ...approvals.created[0], status: "approved" });
  assert.equal(result.status, "published");
  assert.deepEqual(pushes, [REMOTE]);
  const view = genesis.view(project.id);
  assert.equal(view.state, "published");
  assert.deepEqual(view.transitions.slice(-2).map((t) => t.to), ["publishing", "published"]);
  assert.equal(view.transitions.at(-1).evidence.commit, requested.commit);
  assert.equal(await restarted.onApprovalDecided({ ...approvals.created[0], status: "approved" }), null, "an approval is used once");

  // A change after the request makes the approval stale: no push.
  const again = await publisher.request(project.id, { remote: REMOTE });
  writeFileSync(join(project.workspace, "NOTES.md"), "changed\n");
  await commitWorkspace(project.workspace, "Change after approval request");
  const stale = await publisher.onApprovalDecided({ ...approvals.created.at(-1), id: again.approvalId, status: "approved" });
  assert.equal(stale.status, "stale");
  assert.equal(pushes.length, 1);

  // Denied: nothing happens.
  const third = await publisher.request(project.id, { remote: REMOTE });
  assert.deepEqual(await publisher.onApprovalDecided({ id: third.approvalId, status: "denied" }), { status: "denied" });
  assert.equal(pushes.length, 1);
  store.close();
}));

test("policy deny refuses, allow publishes, and a failed push returns to ready with the reason", () => withRoot(async (root) => {
  const { store, genesis, project } = await readyProject(root);
  await assert.rejects(new GenesisPublisher({ genesis, approvals: fakeApprovals("deny") }).request(project.id, { remote: REMOTE }), (error) => error.code === "DENIED_BY_POLICY");
  const failing = new GenesisPublisher({ genesis, approvals: fakeApprovals("allow"), push: async () => ({ ok: false, message: "remote: Repository not found." }) });
  const failed = await failing.request(project.id, { remote: REMOTE });
  assert.equal(failed.status, "failed");
  const view = genesis.view(project.id);
  assert.equal(view.state, "ready");
  assert.match(view.transitions.at(-1).reason, /Repository not found/u);
  const building = await genesis.change(project.id, "add a location field");
  assert.notEqual(building.state, "ready");
  await assert.rejects(failing.request(project.id, { remote: REMOTE }), (error) => error.code === "NOT_READY");
  store.close();
}));

test("pushMain pushes main to a real repository without prompting", () => withRoot(async (root) => {
  const { store, project } = await readyProject(root);
  const bare = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const result = await pushMain(project.workspace, bare);
  assert.equal(result.ok, true, result.message);
  const head = execFileSync("git", ["-C", project.workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), head);
  const missing = await pushMain(project.workspace, join(root, "does-not-exist.git"));
  assert.equal(missing.ok, false);
  store.close();
}));

test("over HTTP: publish waits in Approvals, and approving it there publishes", (t) => withRoot(async (root) => {
  const { store: genesisStore, genesis, project } = await readyProject(root);
  const store = new LocalTaskStore(join(root, "atlas.sqlite"));
  const pushes = [];
  const publisher = new GenesisPublisher({ genesis, approvals: { policy: (c) => store.policy(c), create: (r) => store.createApproval(r), get: (id) => store.approval(id) }, push: async (folder, remote) => { pushes.push(remote); return { ok: true, message: "pushed" }; } });
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), genesis, genesisPublisher: publisher, onApprovalDecided: (approval) => publisher.onApprovalDecided(approval) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  try {
    assert.equal(store.policy("publish.remote").decision, "ask", "the default policy asks");
    const response = await fetch(`${origin}/v1/genesis/${project.id}/publish`, { method: "POST", headers: owner, body: JSON.stringify({ remote: REMOTE }) });
    assert.equal(response.status, 202);
    const { publish } = await response.json();
    const approvals = await (await fetch(`${origin}/v1/approvals`, { headers: owner })).json();
    const pending = approvals.approvals.find((a) => a.id === publish.approvalId);
    assert.equal(pending.status, "pending");
    assert.equal(pending.capability, "publish.remote");
    const decided = await fetch(`${origin}/v1/approvals/${pending.id}/decision`, { method: "POST", headers: owner, body: JSON.stringify({ decision: "approved" }) });
    assert.equal(decided.status, 200);
    for (let i = 0; i < 50 && genesis.view(project.id).state !== "published"; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(genesis.view(project.id).state, "published");
    assert.deepEqual(pushes, [REMOTE]);
    const bad = await fetch(`${origin}/v1/genesis/${project.id}/publish`, { method: "POST", headers: owner, body: JSON.stringify({ remote: "file:///etc" }) });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    genesisStore.close();
  }
}));
