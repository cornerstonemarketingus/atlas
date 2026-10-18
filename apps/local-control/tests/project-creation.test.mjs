import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenesisStore, GenesisService } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor } from "../src/platform/genesis/executor.mjs";
import { GenesisPublisher } from "../src/platform/genesis/publish.mjs";
import { ProjectCreation } from "../src/platform/genesis/create-project.mjs";
import { createRepositoryCreator } from "../src/agent/infrastructure/git-hosts.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";
import { createProjectTools } from "../../web/app/api/chat/project-tools.mjs";
import { converse } from "../../web/app/api/chat/agent-loop.mjs";
import { createGenesisRoutes } from "../src/platform/genesis/routes.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { genesisBridge } from "../../web/app/api/genesis/bridge.mjs";

const secret = "account-token-never-model";
const description = "Build a simple customer lead tracker with: add customer, name/email/phone, status, notes, dashboard, search";
const input = { requestId: "operation_fixture_123", name: "service-tracker", description, template: "web-app", host: "github", visibility: "private" };

function github({ scopes = "repo", httpStatus = 200, createStatus = 201, wrongVisibility = false } = {}) {
  const calls = []; let repo;
  return { calls, fetchImpl: async (url, init = {}) => {
    assert.equal(init.headers.authorization, `Bearer ${secret}`);
    const path = new URL(url).pathname; calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    if (path === "/user") return Response.json({ login: "owner" }, { status: httpStatus, headers: scopes === null ? {} : { "x-oauth-scopes": scopes } });
    if (path === "/user/repos") {
      if (createStatus !== 201) return Response.json({ message: "Resource not accessible by integration" }, { status: createStatus });
      const body = JSON.parse(init.body);
      repo = { full_name: `owner/${body.name}`, private: wrongVisibility ? !body.private : body.private, clone_url: `https://github.com/owner/${body.name}.git`, html_url: `https://github.com/owner/${body.name}` };
      return Response.json(repo, { status: 201 });
    }
    return repo ? Response.json(repo) : Response.json({ message: "Not found" }, { status: 404 });
  } };
}

async function harness(run, { policy = "allow", host = github(), pushOk = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-create-project-"));
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store });
  const executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck,
    preview: { start: async () => ({ ok: true, url: "http://127.0.0.1:9999" }) }, inspector: async () => ({ ok: true, findings: [], evidence: { kind: "mock-browser" } }) });
  const approvals = { created: [], policy: () => ({ decision: policy }), create(request) { const approval = { id: "approval-1", status: "pending", ...request }; this.created.push(approval); return approval; }, get(id) { return this.created.find((a) => a.id === id); } };
  const pushes = [];
  const publisher = new GenesisPublisher({ genesis, approvals, credentials: async (name) => name === "ATLAS_GITHUB_ACCOUNT_TOKEN" ? secret : null,
    adapters: { repositoryCreator: (options) => createRepositoryCreator({ ...options, fetchImpl: host.fetchImpl }) },
    push: async (folder, remote, options) => { assert.ok(existsSync(join(folder, "package.json"))); assert.equal(options.token, secret); assert.match(options.expectedCommit, /^[a-f0-9]{40}$/u); pushes.push(remote); return { ok: pushOk, message: pushOk ? "Verified push" : "Push rejected" }; } });
  const creation = new ProjectCreation({ genesis, executor, publisher });
  try { await run({ root, genesis, store, executor, publisher, creation, approvals, host, pushes }); }
  finally { while (creation.running.size) await new Promise((resolve) => setTimeout(resolve, 20)); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}

async function wait(creation) {
  const deadline = Date.now() + 30000;
  while (creation.running.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(creation.running.size, 0, "operation finishes within a bounded time");
  return creation.status(input.requestId);
}

test("hosted model tool creates an isolated verified Genesis project, creates GitHub repo, verifies and pushes, returns URL", () => harness(async ({ creation, genesis, host, pushes }) => {
  const tools = createProjectTools({ create: creation.create.bind(creation), status: creation.status.bind(creation), requestId: input.requestId, userMessage: "Create a new repo for a simple autonomous online service business." });
  let round = 0; const modelRequests = []; const events = [];
  const outcome = await converse({ endpoint: { baseUrl: "https://model.test/v1", model: "fixture" }, turns: [{ role: "user", content: "Create a new repo for a simple autonomous online service business." }],
    defaultRepository: "cornerstonemarketingus/atlas", userMessage: "Create a new repo", toolContext: { environment: {}, allowlist: new Set() },
    tools: tools.definitions, handlers: tools.handlers, stream: false, emit: (...args) => events.push(args), startTasks: async () => assert.fail("existing repository must never be dispatched"),
    fetcher: async (_url, init) => {
      modelRequests.push(JSON.parse(init.body)); round++;
      if (round === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "create", type: "function", function: { name: "workspace_create_project", arguments: JSON.stringify(input) } }] } }] });
      await wait(creation);
      if (round === 2) return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "status", type: "function", function: { name: "workspace_project_status", arguments: JSON.stringify({ operationId: input.requestId }) } }] } }] });
      return Response.json({ choices: [{ message: { content: "Repository created: https://github.com/owner/service-tracker" } }] });
    } });
  assert.match(outcome.reply, /https:\/\/github.com\/owner\/service-tracker/);
  const result = creation.status(input.requestId); assert.equal(result.status, "published", JSON.stringify(result)); assert.equal(result.visibility, "private"); assert.equal(result.deploymentState, "not-deployed");
  const project = genesis.view(result.projectId); assert.equal(project.name, input.name);
  assert.ok(project.transitions.find((t) => t.to === "previewing").evidence.results.every((check) => check.exitCode === 0));
  assert.deepEqual(host.calls.filter((c) => c.path === "/user/repos").map((c) => c.body.private), [true]);
  assert.deepEqual(pushes, ["https://github.com/owner/service-tracker.git"]);
  assert.doesNotMatch(JSON.stringify(modelRequests), new RegExp(secret));
  assert.ok(events.some(([type, result]) => type === "project" && result.status === "published"));
  assert.equal((await creation.create(input)).projectId, project.id); assert.equal(genesis.list().length, 1);
  await assert.rejects(creation.create({ ...input, name: "different" }), /different project/);
}));

test("ask waits for the exact approval; deny never builds or creates", () => harness(async ({ creation, publisher, approvals, pushes }) => {
  await creation.create(input); let result = await wait(creation); assert.equal(result.status, "awaiting-approval"); assert.deepEqual(pushes, []);
  assert.equal(approvals.created[0].capability, "publish.remote");
  approvals.created[0].status = "approved";
  await publisher.onApprovalDecided(approvals.created[0]); result = creation.status(input.requestId); assert.equal(result.status, "published"); assert.equal(pushes.length, 1);
}, { policy: "ask" }));

test("deny policy and missing account scope are actionable and do not create workspaces", async () => {
  for (const options of [{ policy: "deny" }, { host: github({ scopes: "read:user,user:email" }) }, { host: github({ httpStatus: 401 }) }]) await harness(async ({ creation, genesis, host }) => {
    const result = await creation.create(input); assert.equal(result.status, "unavailable"); assert.match(result.message, /account-level|policy/); assert.equal(genesis.list().length, 0); assert.equal(host.calls.filter((c) => c.method === "POST").length, 0);
  }, options);
});

test("unknown fine-grained permissions use real create result; failed push never reports published", async () => {
  for (const options of [{ host: github({ scopes: null, createStatus: 403 }) }, { pushOk: false }, { host: github({ wrongVisibility: true }) }]) await harness(async ({ creation }) => {
    await creation.create(input); const result = await wait(creation); assert.equal(result.status, "failed"); assert.notEqual(result.projectState, "published"); assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }, options);
});

test("capabilities distinguish classic private/public scopes, unknown permissions and invalid credentials", async () => {
  for (const [options, visibility, expected, reason] of [[{ scopes: "repo" }, "private", true, null], [{ scopes: "public_repo" }, "private", false, "insufficient_permission"], [{ scopes: "public_repo" }, "public", true, null], [{ scopes: null }, "private", null, "permission_unverified"], [{ httpStatus: 401 }, "private", false, "invalid_credential"]]) {
    const host = github(options); const adapter = createRepositoryCreator({ host: "github", token: secret, fetchImpl: host.fetchImpl });
    const capability = await adapter.capabilities({ visibility }); assert.equal(capability.canCreateRepositories, expected); assert.equal(capability.reason, reason); assert.equal(host.calls.some((c) => c.method === "POST"), false);
  }
});

test("HTTPS hosted bridge reaches the real authenticated local-control operations routes", () => harness(async ({ root, genesis, publisher, creation }) => {
  const store = new LocalTaskStore(join(root, "local.sqlite"));
  const token = "0123456789abcdef0123456789abcdef";
  const server = createLocalControlServer({ store, token, runTask: async () => ({}), genesis, genesisPublisher: publisher, genesisCreation: creation });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${origin}/v1/genesis/operations`, { method: "POST", body: JSON.stringify(input) })).status, 401);
    const bridge = genesisBridge({ ATLAS_GENESIS_URL: "https://genesis.test", ATLAS_GENESIS_TOKEN: token }, { owner: true,
      // CI maps the configured HTTPS transport to a loopback test server only.
      fetchImpl: (url, init) => fetch(new URL(new URL(url).pathname + new URL(url).search, origin), init) });
    assert.equal((await bridge.capabilities()).github.canCreateRepositories, true);
    assert.equal((await bridge.create(input)).status, "building");
    await wait(creation);
    assert.equal((await bridge.status(input.requestId)).status, "published");
    const invalid = await fetch(`${origin}/v1/genesis/operations`, { method: "POST", headers, body: JSON.stringify({ ...input, name: "../../atlas", requestId: "bad_payload_request" }) });
    assert.equal(invalid.status, 400);
    let returned;
    const route = createGenesisRoutes({ genesis, publisher, creation, parseBody: async () => assert.fail("device cannot read a privileged request"), send: (_response, status) => { returned = status; return true; } });
    await route({ url: "/v1/genesis/capabilities", method: "GET" }, {}, { role: "device" });
    assert.equal(returned, 403);
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
}));

test("concurrent retries reserve only one operation, and restart never replays an uncertain external action", () => harness(async ({ creation, genesis, store, executor, publisher }) => {
  const receipts = await Promise.all([creation.create(input), creation.create(input)]);
  assert.equal(receipts[0].operationId, receipts[1].operationId);
  await wait(creation); assert.equal(genesis.list().length, 1);
  const operation = store.operation(input.requestId);
  store.saveOperation({ id: "interrupted_operation_123", digest: "fixture", spec: operation.spec, status: "publishing" });
  const restarted = new ProjectCreation({ genesis, executor, publisher });
  assert.equal(restarted.status("interrupted_operation_123").status, "interrupted");
  assert.match(restarted.status("interrupted_operation_123").message, /never replayed/);
  assert.equal(restarted.running.size, 0);
}));

test("resolving a blocked plan continues the same project into policy-controlled publication", () => harness(async ({ creation, genesis, store, executor }) => {
  genesis.policy = () => ({ decision: "ask" });
  await creation.create(input); let result = await wait(creation);
  assert.equal(result.status, "blocked"); assert.equal(result.projectState, "planned");
  genesis.approve(result.projectId); await executor.run(result.projectId);
  creation.onReady(result.projectId); result = await wait(creation);
  assert.equal(result.status, "published"); assert.equal(genesis.list().length, 1);
  assert.equal(store.operation(input.requestId).message, null);
}));
