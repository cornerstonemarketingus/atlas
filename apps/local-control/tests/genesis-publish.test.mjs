import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisPublisher, PublishError, assertRemote, collectStaticFiles, publishDigest, pushMain } from "../src/platform/genesis/publish.mjs";
import { createRepositoryCreator } from "../src/agent/infrastructure/git-hosts.mjs";
import { createVercelAdapter } from "../src/agent/infrastructure/vercel.mjs";
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

function fakeGitHub({ taken = [] } = {}) {
  const repos = new Map(taken.map((name) => [`owner/${name}`, { full_name: `owner/${name}` }]));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    calls.push(`${init.method ?? "GET"} ${pathname}`);
    assert.equal(init.headers.authorization, "Bearer gh-token", "the token is only ever sent to the host");
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (pathname === "/user") return json(200, { login: "owner" });
    if (pathname === "/user/repos" && init.method === "POST") {
      const body = JSON.parse(init.body);
      repos.set(`owner/${body.name}`, { full_name: `owner/${body.name}`, private: body.private, clone_url: `https://github.com/owner/${body.name}.git`, html_url: `https://github.com/owner/${body.name}` });
      return json(201, repos.get(`owner/${body.name}`));
    }
    const repo = repos.get(pathname.replace(/^\/repos\//u, ""));
    return repo ? json(200, repo) : json(404, { message: "Not Found" });
  };
  return { fetchImpl, calls, repos };
}

function fakeVercel({ finalState = "READY" } = {}) {
  const deployments = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    assert.equal(init.headers.authorization, "Bearer vc-token");
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (pathname === "/v13/deployments" && init.method === "POST") {
      const body = JSON.parse(init.body);
      deployments.push(body);
      return json(200, { id: "dpl_1", readyState: "QUEUED", url: `${body.name}-abc.vercel.app` });
    }
    if (pathname === "/v13/deployments/dpl_1") return json(200, { id: "dpl_1", readyState: finalState, url: `${deployments[0].name}-abc.vercel.app` });
    return json(404, { error: { message: "not found" } });
  };
  return { fetchImpl, deployments };
}

async function readySite(root) {
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const project = await genesis.create("Build a website for my roofing company");
  const workspace = await createWorkspace({ root: join(root, "projects"), projectId: project.id, spec: project.spec, templateId: project.plan.template });
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: workspace.folder });
  genesis.advance(project.id, "scaffolding", { reason: "s" });
  genesis.advance(project.id, "building", { reason: "b", patch: { workspace: workspace.folder } });
  for (const to of ["verifying", "previewing", "reviewing", "ready"]) genesis.advance(project.id, to, { reason: to });
  return { store, genesis, project: genesis.view(project.id) };
}

test("creating a repository is planned, approved, created on the host, verified and pushed to", () => withRoot(async (root) => {
  const { store, genesis, project } = await readyProject(root);
  const github = fakeGitHub({ taken: ["item-api"] });
  const pushes = [];
  const approvals = fakeApprovals("ask");
  const publisher = new GenesisPublisher({
    genesis, approvals,
    credentials: async (name) => (name === "ATLAS_GITHUB_TOKEN" ? "gh-token" : null),
    push: async (folder, remote) => { pushes.push(remote); return { ok: true, message: "pushed" }; },
    adapters: { repositoryCreator: (options) => (0, createRepositoryCreator)({ ...options, fetchImpl: github.fetchImpl }) },
  });
  await assert.rejects(publisher.requestRepository(project.id, { host: "github" }), (error) => error.code === "EXISTS", "an existing name is refused before anything is asked");
  const requested = await publisher.requestRepository(project.id, { host: "github", name: "inventory-api", visibility: "private" });
  assert.equal(requested.status, "awaiting-approval");
  assert.match(approvals.created[0].summary, /Create owner\/inventory-api \(private\) on github/u);
  assert.ok(!github.calls.includes("POST /user/repos"), "nothing is created before approval");
  assert.doesNotMatch(JSON.stringify(genesis.view(project.id)), /gh-token/u, "the token never reaches project state");
  const result = await publisher.onApprovalDecided({ ...approvals.created[0], status: "approved" });
  assert.equal(result.status, "published", JSON.stringify(result));
  assert.ok(github.calls.includes("POST /user/repos"));
  assert.deepEqual(pushes, ["https://github.com/owner/inventory-api.git"]);
  assert.equal(genesis.view(project.id).transitions.at(-1).evidence.repository.webUrl, "https://github.com/owner/inventory-api");
  await assert.rejects(new GenesisPublisher({ genesis, approvals, credentials: async () => null }).requestRepository(project.id, { host: "github" }), (error) => error.code === "NO_CREDENTIAL");
  store.close();
}));

test("a static site deploys to Vercel only after approval, only with the approved files, and is verified ready", () => withRoot(async (root) => {
  const { store, genesis, project } = await readySite(root);
  const vercel = fakeVercel();
  const approvals = fakeApprovals("ask");
  const publisher = new GenesisPublisher({
    genesis, approvals,
    credentials: async (name) => (name === "ATLAS_VERCEL_TOKEN" ? "vc-token" : null),
    adapters: { vercel: (options) => createVercelAdapter({ ...options, fetchImpl: vercel.fetchImpl }) },
  });
  const requested = await publisher.requestDeployment(project.id, { target: "preview" });
  assert.equal(requested.status, "awaiting-approval");
  assert.equal(approvals.created[0].capability, "deploy.remote");
  assert.equal(requested.plan.files, collectStaticFiles(project.workspace).length);
  assert.equal(vercel.deployments.length, 0, "nothing is deployed before approval");
  const result = await publisher.onApprovalDecided({ ...approvals.created[0], status: "approved" });
  assert.equal(result.status, "deployed", JSON.stringify(result));
  assert.equal(result.deployment.url, "https://roofing-company-abc.vercel.app");
  const sent = vercel.deployments[0];
  assert.ok(sent.files.some((file) => file.file === "index.html" && Buffer.from(file.data, "base64").toString().includes("<h1>")), "the built pages were uploaded");
  assert.equal(genesis.view(project.id).state, "published");

  // A rebuilt site no longer matches the approved plan.
  const again = await publisher.requestDeployment(project.id, { target: "preview" });
  writeFileSync(join(project.workspace, "dist", "index.html"), "<h1>changed</h1>");
  const stale = await publisher.onApprovalDecided({ ...approvals.created.at(-1), id: again.approvalId, status: "approved" });
  assert.equal(stale.status, "failed");
  assert.match(stale.message, /changed after this deployment was approved/u);
  store.close();
}));

test("apps that need a server are not deployed to static hosting, and say where they can run", () => withRoot(async (root) => {
  const { store, genesis, project } = await readyProject(root);
  const publisher = new GenesisPublisher({ genesis, approvals: fakeApprovals("allow"), credentials: async () => "token" });
  await assert.rejects(publisher.requestDeployment(project.id, {}), (error) => error.code === "NEEDS_SERVER" && /Reach Atlas/u.test(error.message));
  await assert.rejects(new GenesisPublisher({ genesis, approvals: fakeApprovals("deny"), credentials: async () => "token" }).requestRepository(project.id, { host: "github" }), (error) => error.code === "DENIED_BY_POLICY");
  store.close();
}));

test("adaptive autonomy: with deploys allowed, a preview deploys at once but production waits for a level 4 approval", () => withRoot(async (root) => {
  const { store, genesis, project } = await readySite(root);
  const vercel = fakeVercel();
  const approvals = fakeApprovals("allow");
  const publisher = new GenesisPublisher({
    genesis, approvals,
    credentials: async (name) => (name === "ATLAS_VERCEL_TOKEN" ? "vc-token" : null),
    adapters: { vercel: (options) => createVercelAdapter({ ...options, fetchImpl: vercel.fetchImpl }) },
  });
  const production = await publisher.requestDeployment(project.id, { target: "production" });
  assert.equal(production.status, "awaiting-approval", "allowed deploys still ask for production");
  assert.equal(approvals.created[0].riskLevel, 4, "and the approval is confirmed a second time");
  assert.equal(vercel.deployments.length, 0);
  const preview = await publisher.requestDeployment(project.id, { target: "preview" });
  assert.equal(preview.status, "deployed", JSON.stringify(preview));
  assert.equal(approvals.created.length, 1, "a preview needs no approval when deploys are allowed");
  store.close();
}));
