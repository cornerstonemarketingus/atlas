import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenesisStore, GenesisService } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor } from "../src/platform/genesis/executor.mjs";
import { GenesisPublisher } from "../src/platform/genesis/publish.mjs";
import { ProjectCreation } from "../src/platform/genesis/create-project.mjs";
import { createRepositoryCreator } from "../src/agent/infrastructure/git-hosts.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { genesisBridge } from "../../web/app/api/genesis/bridge.mjs";

// The hosted Worker's bridge against the real daemon over a loopback socket.
// https://node.test is mapped to that socket, and like cloudflared the mapping
// adds the proxy headers a real tunnel adds (they make the daemon treat the
// request as remote).
const OWNER_TOKEN = "owner-token-0123456789abcdef0123456789";
const GENESIS_TOKEN = "genesis-token-abcdef0123456789abcdef01";
const ACCOUNT_SECRET = "account-token-never-leaves-node";
const input = { requestId: "operation_bridge_proto_1", name: "bridge-proto", description: "Build a simple customer lead tracker with: add customer, name/email/phone, status, notes, dashboard, search", template: "web-app", host: "github", visibility: "private" };

function githubHost() {
  let repo;
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/user") return Response.json({ login: "owner" }, { headers: { "x-oauth-scopes": "repo" } });
    if (path === "/user/repos") { const body = JSON.parse(init.body); repo = { full_name: `owner/${body.name}`, private: body.private, clone_url: `https://github.com/owner/${body.name}.git`, html_url: `https://github.com/owner/${body.name}` }; return Response.json(repo, { status: 201 }); }
    if (repo) return Response.json(repo);
    return Response.json({ message: "Not found" }, { status: 404 });
  };
}

async function node(run) {
  const root = mkdtempSync(join(tmpdir(), "atlas-bridge-proto-"));
  const genesisStore = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store: genesisStore });
  const executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck,
    preview: { start: async () => ({ ok: true, url: "http://127.0.0.1:9999" }) }, inspector: async () => ({ ok: true, findings: [], evidence: { kind: "mock-browser" } }) });
  const approvals = { policy: () => ({ decision: "allow" }), create: () => ({ id: "a1", status: "pending" }), get: () => null };
  const publisher = new GenesisPublisher({ genesis, approvals, credentials: async (name) => name === "ATLAS_GITHUB_ACCOUNT_TOKEN" ? ACCOUNT_SECRET : null,
    adapters: { repositoryCreator: (options) => createRepositoryCreator({ ...options, fetchImpl: githubHost() }) },
    push: async () => ({ ok: true, message: "Verified." }) });
  const creation = new ProjectCreation({ genesis, executor, publisher });
  const local = new LocalTaskStore(join(root, "local.sqlite"));
  const server = createLocalControlServer({ store: local, token: OWNER_TOKEN, genesisToken: GENESIS_TOKEN, runTask: async () => ({}), genesis, genesisPublisher: publisher, genesisCreation: creation });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const seen = [];
  const tunnel = (url, init = {}) => {
    const target = new URL(new URL(url).pathname + new URL(url).search, origin);
    seen.push(`${init.method ?? "GET"} ${target.pathname}`);
    return fetch(target, { ...init, headers: { ...init.headers, "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7" } });
  };
  const bridgeWith = (token, options = {}) => genesisBridge({ ATLAS_GENESIS_URL: "https://node.test", ATLAS_GENESIS_TOKEN: token }, { owner: true, fetchImpl: tunnel, ...options });
  try { await run({ origin, creation, bridgeWith, seen, local }); }
  finally {
    while (creation.running.size) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); local.close(); genesisStore.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function settle(creation) {
  const deadline = Date.now() + 90000;
  while (creation.running.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(creation.running.size, 0, "operation did not finish");
}

test("through a tunnel, the genesis credential drives capabilities, create and status end to end", () => node(async ({ bridgeWith, creation, seen }) => {
  const bridge = bridgeWith(GENESIS_TOKEN);
  assert.equal(bridge.available, true);
  const capabilities = await bridge.capabilities();
  assert.equal(capabilities.github.canCreateRepositories, true);
  const receipt = await bridge.create(input);
  assert.equal(receipt.status, "building"); assert.equal(receipt.operationId, input.requestId);
  await settle(creation);
  const done = await bridge.status(input.requestId);
  assert.equal(done.status, "published", JSON.stringify(done));
  assert.match(JSON.stringify(done), /github\.com\/owner\/bridge-proto/);
  assert.doesNotMatch(JSON.stringify([capabilities, receipt, done]), new RegExp(ACCOUNT_SECRET));
  assert.deepEqual([...new Set(seen)].sort(), ["GET /v1/genesis/capabilities", `GET /v1/genesis/operations/${input.requestId}`, "POST /v1/genesis/operations"].sort());
}));

test("regression: the owner token is refused through a tunnel, so a bridge given it can never connect", () => node(async ({ bridgeWith }) => {
  const outcome = await bridgeWith(OWNER_TOKEN).create(input);
  assert.equal(outcome.status, "unavailable"); assert.equal(outcome.reason, "node_rejected_token");
}));

test("a wrong token and a paired-device token are both rejected", () => node(async ({ bridgeWith, origin, local }) => {
  assert.equal((await bridgeWith("x".repeat(40)).create(input)).reason, "node_rejected_token");
  assert.equal((await bridgeWith("x".repeat(40)).status(input.requestId)).reason, "node_rejected_token");
  assert.equal((await bridgeWith("x".repeat(40)).capabilities()).github.canCreateRepositories, false);
  const code = "123456";
  local.addPairingCode(createHash("sha256").update(code).digest("hex"), new Date(Date.now() + 60_000).toISOString());
  const claimed = await (await fetch(`${origin}/v1/pair/claim`, { method: "POST", body: JSON.stringify({ code, name: "Phone" }) })).json();
  assert.ok(claimed.deviceToken);
  const asDevice = bridgeWith(claimed.deviceToken, { fetchImpl: (url, init) => fetch(new URL(new URL(url).pathname + new URL(url).search, origin), init) });
  assert.equal((await asDevice.create(input)).reason, "node_rejected_token");
  assert.equal((await asDevice.capabilities()).github.canCreateRepositories, false);
  assert.equal((await fetch(`${origin}/v1/genesis/capabilities`)).status, 401);
}));

test("the genesis credential reaches only the genesis operations routes", () => node(async ({ origin }) => {
  const headers = { authorization: `Bearer ${GENESIS_TOKEN}`, "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" };
  for (const [method, path] of [["GET", "/v1/tasks"], ["GET", "/v1/genesis"], ["GET", "/v1/genesis/templates"], ["POST", "/v1/genesis"], ["POST", "/v1/genesis/gen_00000000-0000-0000-0000-000000000000/approve"],
    ["POST", "/v1/pair"], ["GET", "/v1/devices"], ["GET", "/v1/policies"], ["PUT", "/v1/policies"], ["GET", "/v1/audit"], ["POST", "/v1/export"], ["GET", "/v1/identity"], ["GET", "/v1/genesis/capabilitiesx"]]) {
    const response = await fetch(`${origin}${path}`, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(response.status, 403, `${method} ${path} -> ${response.status}`);
  }
  assert.equal((await fetch(`${origin}/v1/genesis/capabilities`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/health`)).status, 200);
}));

test("a genesis credential must be long and different from the owner token; unset means disabled", () => {
  const local = new LocalTaskStore(":memory:");
  try {
    for (const bad of ["short", OWNER_TOKEN]) assert.throws(() => createLocalControlServer({ store: local, token: OWNER_TOKEN, genesisToken: bad, runTask: async () => ({}) }), /ATLAS_GENESIS_TOKEN/);
    assert.ok(createLocalControlServer({ store: local, token: OWNER_TOKEN, runTask: async () => ({}) }));
  } finally { local.close(); }
});

test("a node that accepts the connection but never answers is bounded by the capability deadline", async () => {
  const stalled = createServer(() => { /* never respond */ });
  await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${stalled.address().port}`;
  try {
    const bridge = genesisBridge({ ATLAS_GENESIS_URL: "https://node.test", ATLAS_GENESIS_TOKEN: GENESIS_TOKEN }, { owner: true, capabilityTimeoutMs: 100,
      fetchImpl: (url, init) => fetch(new URL(new URL(url).pathname + new URL(url).search, origin), init) });
    const started = Date.now();
    const capabilities = await bridge.capabilities();
    assert.ok(Date.now() - started < 2000);
    assert.equal(capabilities.github.canCreateRepositories, false);
  } finally { stalled.closeAllConnections(); await new Promise((resolve) => stalled.close(resolve)); }
});

test("create gives up after the 15 second operation deadline when the node hangs", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const bridge = genesisBridge({ ATLAS_GENESIS_URL: "https://node.test", ATLAS_GENESIS_TOKEN: GENESIS_TOKEN }, { owner: true, fetchImpl: () => new Promise(() => {}) });
    const pending = bridge.create(input);
    let settled = false; pending.then(() => { settled = true; });
    mock.timers.tick(14_999);
    await Promise.resolve(); assert.equal(settled, false);
    mock.timers.tick(1);
    const outcome = await pending;
    assert.equal(outcome.status, "unavailable"); assert.equal(outcome.reason, "node_timeout"); assert.equal(outcome.operationId, undefined);
  } finally { mock.timers.reset(); }
});

test("a node that is down reports node_unreachable, not a completion", async () => {
  const bridge = genesisBridge({ ATLAS_GENESIS_URL: "https://node.test", ATLAS_GENESIS_TOKEN: GENESIS_TOKEN }, { owner: true, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.equal((await bridge.create(input)).reason, "node_unreachable");
  assert.equal((await bridge.status(input.requestId)).reason, "node_unreachable");
});
