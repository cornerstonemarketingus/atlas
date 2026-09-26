import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import { PlatformTaskStore } from "../src/platform/task-store.mjs";
import { PolicyEngine } from "../src/platform/policy.mjs";
import { AtlasMcpServer, createAtlasMcpHttpServer, serveStdio, createTokenResolver } from "../src/platform/mcp-server/index.mjs";
import { McpClient, createStdioTransport } from "../src/platform/mcp/jsonrpc-stdio.mjs";
import { createStreamableHttpTransport } from "../src/platform/mcp/http-transport.mjs";
import { McpGateway } from "../src/platform/mcp/gateway.mjs";

const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-server-"));
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
  rmSync(dir, { recursive: true, force: true });
});

const TOKEN_A = "atlas_tok_A_0123456789abcdef";
const TOKEN_B = "atlas_tok_B_0123456789abcdef";
const TOKEN_READONLY = "atlas_tok_R_0123456789abcdef";
const principals = {
  a: { tenantId: "tenant-a", userId: "alice", grantedPermissions: ["atlas.*"] },
  b: { tenantId: "tenant-b", userId: "bob", grantedPermissions: ["atlas.*"] },
  r: { tenantId: "tenant-a", userId: "reader", grantedPermissions: ["atlas.status_lookup", "atlas.list_tasks"] },
};

let n = 0;
function harness({ rules = [] } = {}) {
  const dbFile = join(dir, `store-${++n}.sqlite`);
  const store = new PlatformTaskStore(dbFile);
  cleanups.push(() => store.close());
  const audit = [];
  const server = new AtlasMcpServer({ store, policy: new PolicyEngine({ version: "mcp.test.1", rules }), audit: (e) => audit.push(e) });
  return { store, server, audit, dbFile };
}

async function httpHarness(opts) {
  const h = harness(opts);
  const http = createAtlasMcpHttpServer({
    server: h.server,
    tokens: [{ token: TOKEN_A, principal: principals.a }, { token: TOKEN_B, principal: principals.b }, { token: TOKEN_READONLY, principal: principals.r }],
  });
  const url = await http.listen();
  cleanups.push(() => http.close());
  return { ...h, http, url };
}

async function httpClient(url, token) {
  const transport = createStreamableHttpTransport({ url, allowLoopback: true, getToken: () => token });
  const client = new McpClient({ transport, requestTimeoutMs: 5000 });
  cleanups.push(() => client.close());
  await client.initialize();
  return { client, transport };
}

async function rawPost(url, { token, body, headers = {} }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const initMsg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } } };

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

test("server core: tools/list exposes exactly the four Atlas tools with output schemas", async () => {
  const { server } = harness();
  const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, principals.a);
  assert.deepEqual(res.result.tools.map((t) => t.name).sort(), ["atlas.create_task", "atlas.list_artifacts", "atlas.list_tasks", "atlas.status_lookup"]);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.outputSchema.type, "object");
  }
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 2, method: "nope" }, principals.a)).error.code, -32601);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, principals.a), undefined);
});

test("server core: every call is policy-checked and audited; denied, invalid and require_approval never execute", async () => {
  const { server, store, audit } = harness({ rules: [{ id: "gate-create", tool: "atlas.create_task", effect: "require_approval" }] });
  const args = { objective: "Summarize the Q3 report", successCriteria: ["summary exists"] };
  const denied = await server.callTool(principals.r, "atlas.create_task", args);
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, "UNAUTHORIZED");
  const approval = await server.callTool(principals.a, "atlas.create_task", args);
  assert.equal(approval.isError, true);
  assert.match(approval.content[0].text, /requires approval/);
  const invalid = await server.callTool(principals.a, "atlas.status_lookup", { taskId: "x", extra: 1 });
  assert.equal(invalid.structuredContent.error.code, "INVALID_ARGUMENTS");
  const unauthenticated = await server.callTool(null, "atlas.list_tasks", {});
  assert.equal(unauthenticated.structuredContent.error.code, "UNAUTHENTICATED");
  assert.equal(store.listTasks("tenant-a").length, 0, "nothing was created");
  assert.deepEqual(audit.map((e) => [e.tool, e.outcome, e.reason]), [
    ["atlas.create_task", "denied", "UNAUTHORIZED"],
    ["atlas.create_task", "denied", "UNAUTHORIZED"],
    ["atlas.status_lookup", "denied", "INVALID_ARGUMENTS"],
    ["atlas.list_tasks", "denied", "UNAUTHENTICATED"],
  ]);
  assert.equal(audit[0].policyVersion, "mcp.test.1");
  assert.equal(audit[1].effect, "require_approval");
  for (const e of audit) {
    assert.equal(e.type, "atlas_mcp.call");
    assert.ok(!JSON.stringify(e).includes("Q3 report"), "raw args are not audited");
  }
});

test("server core: create_task yields a proposed task only; no tool can authorize or run it", async () => {
  const { server, store, audit } = harness();
  const out = await server.callTool(principals.a, "atlas.create_task", { objective: "Draft release notes", successCriteria: ["notes drafted"], budget: { toolCalls: 5 } });
  assert.equal(out.isError, undefined);
  const { task } = out.structuredContent;
  assert.equal(task.status, "proposed");
  assert.equal(store.getTask("tenant-a", task.id).status, "proposed");
  assert.equal(store.getTask("tenant-a", task.id).userId, "alice");
  const sneaky = await server.callTool(principals.a, "atlas.create_task", { objective: "x", successCriteria: ["y"], status: "running" });
  assert.equal(sneaky.structuredContent.error.code, "INVALID_ARGUMENTS");
  for (const name of ["atlas.authorize_task", "atlas.run_task", "atlas.transition_task"]) {
    assert.equal((await server.callTool(principals.a, name, { taskId: task.id })).structuredContent.error.code, "UNKNOWN_TOOL");
  }
  assert.equal(audit.find((e) => e.outcome === "success").tool, "atlas.create_task");
  assert.match(audit.find((e) => e.outcome === "success").outputDigest, /^sha256:/);
});

test("server core: list_artifacts is tenant-scoped and returns metadata only", async () => {
  const { server, store } = harness();
  const task = store.createTask({ tenantId: "tenant-a", userId: "alice", objective: "o", successCriteria: ["c"] });
  store.submitArtifact({ tenantId: "tenant-a", taskId: task.id, kind: "report", content: { secret: "body" } });
  const out = await server.callTool(principals.a, "atlas.list_artifacts", { taskId: task.id });
  assert.equal(out.structuredContent.artifacts.length, 1);
  assert.equal(out.structuredContent.artifacts[0].kind, "report");
  assert.ok(!JSON.stringify(out).includes("body"));
  const cross = await server.callTool(principals.b, "atlas.list_artifacts", { taskId: task.id });
  assert.equal(cross.structuredContent.error.code, "NOT_FOUND");
  assert.deepEqual((await server.callTool(principals.b, "atlas.list_artifacts", {})).structuredContent.artifacts, []);
});

test("token resolver: constant-time compare picks the right principal and rejects others", () => {
  const resolve = createTokenResolver([{ token: TOKEN_A, principal: principals.a }, { token: TOKEN_B, principal: principals.b }]);
  assert.equal(resolve(TOKEN_A).principal.tenantId, "tenant-a");
  assert.equal(resolve(TOKEN_B).principal.tenantId, "tenant-b");
  assert.equal(resolve("atlas_tok_A_0123456789abcdeX"), null);
  assert.equal(resolve(""), null);
  assert.throws(() => createTokenResolver([{ token: "short", principal: principals.a }]));
  assert.throws(() => createAtlasMcpHttpServer({ server: harness().server, tokens: [], host: "0.0.0.0" }), /loopback only/);
});

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

test("stdio (in process): initialize, tools/list, status lookup", async () => {
  const { server, store } = harness();
  const task = store.createTask({ tenantId: "tenant-a", userId: "alice", objective: "stdio task", successCriteria: ["ok"] });
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = serveStdio({ server, principal: principals.a, input, output });
  const lines = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => input.write(`${JSON.stringify(m)}\n`);
  send(initMsg);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "atlas.status_lookup", arguments: { taskId: task.id } } });
  input.write("not json\n");
  for (let i = 0; i < 200 && lines.length < 4; i += 1) await new Promise((r) => setTimeout(r, 5));
  const byId = (id) => lines.find((l) => l.id === id);
  assert.equal(byId(1).result.protocolVersion, "2025-06-18");
  assert.equal(byId(2).result.tools.length, 4);
  assert.equal(byId(3).result.structuredContent.task.objective, "stdio task");
  assert.equal(byId(null).error.code, -32700);
  assert.deepEqual(lines.filter((l) => l.id !== null).map((l) => l.id), [1, 2, 3], "responses in arrival order");
  handle.close();
});

test("stdio (child process) via McpGateway: round trip, proposed task, cross-tenant not found", async () => {
  const { store, dbFile } = harness();
  const foreign = store.createTask({ tenantId: "tenant-b", userId: "bob", objective: "tenant b secret", successCriteria: ["x"] });
  const auditFile = join(dir, "stdio-audit.jsonl");
  const main = fileURLToPath(new URL("../src/platform/mcp-server/main-stdio.mjs", import.meta.url));
  const gateway = new McpGateway({ authorize: () => true });
  cleanups.push(() => gateway.close());
  gateway.registerServer({
    tenantId: "tenant-a", serverId: "atlas", allowedTools: ["atlas.*"], trust: "reviewed", timeoutMs: 10_000,
    transportFactory: () => createStdioTransport({
      argv: [process.execPath, "--no-warnings", main],
      env: { ATLAS_MCP_DB: dbFile, ATLAS_MCP_TENANT: "tenant-a", ATLAS_MCP_USER: "alice", ATLAS_MCP_PERMISSIONS: "atlas.*", ATLAS_MCP_AUDIT: auditFile },
    }),
  });
  const ctx = { tenantId: "tenant-a", userId: "alice" };
  const tools = await gateway.discover("atlas", ctx);
  assert.deepEqual(tools.map((t) => t.name).sort(), ["atlas.create_task", "atlas.list_artifacts", "atlas.list_tasks", "atlas.status_lookup"]);
  const created = await gateway.callTool(ctx, "atlas", "atlas.create_task", { objective: "Via stdio", successCriteria: ["done"] });
  assert.equal(created.untrusted, true);
  const id = created.structuredContent.task.id;
  assert.equal(created.structuredContent.task.status, "proposed");
  const looked = await gateway.callTool(ctx, "atlas", "atlas.status_lookup", { taskId: id });
  assert.equal(looked.structuredContent.task.status, "proposed");
  const cross = await gateway.callTool(ctx, "atlas", "atlas.status_lookup", { taskId: foreign.id });
  assert.equal(cross.isError, true);
  assert.equal(cross.structuredContent.error.code, "NOT_FOUND");
  assert.ok(!JSON.stringify(cross).includes("tenant b secret"));
  assert.equal(store.getTask("tenant-a", id).status, "proposed", "visible in the shared store, still proposed");
  const audit = readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((e) => e.outcome), ["success", "success", "error"]);
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test("http: initialize issues a session; tools/list and status lookup work", async () => {
  const { url, store } = await httpHarness();
  const task = store.createTask({ tenantId: "tenant-a", userId: "alice", objective: "http task", successCriteria: ["ok"] });
  const { client, transport } = await httpClient(url, TOKEN_A);
  assert.ok(transport.sessionId);
  assert.equal((await client.listTools()).length, 4);
  const res = await client.callTool("atlas.status_lookup", { taskId: task.id });
  assert.equal(res.structuredContent.task.objective, "http task");
  const listed = await client.callTool("atlas.list_tasks", { status: "proposed" });
  assert.deepEqual(listed.structuredContent.tasks.map((t) => t.id), [task.id]);
});

test("http: create_task produces a proposed task owned by the token's principal", async () => {
  const { url, store } = await httpHarness();
  const { client } = await httpClient(url, TOKEN_A);
  const res = await client.callTool("atlas.create_task", { objective: "From HTTP", successCriteria: ["exists"] });
  const task = store.getTask("tenant-a", res.structuredContent.task.id);
  assert.equal(task.status, "proposed");
  assert.equal(task.userId, "alice");
});

test("http: missing or wrong bearer token is 401; bad origin 403; session rules enforced", async () => {
  const { url } = await httpHarness();
  const none = await rawPost(url, { body: initMsg });
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate"), /^Bearer/);
  assert.equal((await rawPost(url, { token: "atlas_tok_A_0123456789abcdeX", body: initMsg })).status, 401);
  assert.equal((await rawPost(url, { token: TOKEN_A, body: initMsg, headers: { origin: "https://evil.example" } })).status, 403);
  const ok = await rawPost(url, { token: TOKEN_A, body: initMsg, headers: { origin: "http://localhost:3000" } });
  assert.equal(ok.status, 200);
  const sid = ok.headers.get("mcp-session-id");
  assert.ok(sid);
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  assert.equal((await rawPost(url, { token: TOKEN_A, body: list })).status, 400, "missing session id");
  assert.equal((await rawPost(url, { token: TOKEN_A, body: list, headers: { "mcp-session-id": "nope" } })).status, 404);
  assert.equal((await rawPost(url, { token: TOKEN_B, body: list, headers: { "mcp-session-id": sid } })).status, 404, "session bound to its token");
  assert.equal((await rawPost(url, { token: TOKEN_A, body: list, headers: { "mcp-session-id": sid, "mcp-protocol-version": "1999-01-01" } })).status, 400);
  assert.equal((await rawPost(url, { token: TOKEN_A, body: [list], headers: { "mcp-session-id": sid } })).status, 400, "no batching");
  const good = await rawPost(url, { token: TOKEN_A, body: list, headers: { "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } });
  assert.equal(good.status, 200);
  assert.equal(good.body.result.tools.length, 4);
  const note = await rawPost(url, { token: TOKEN_A, body: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: { "mcp-session-id": sid } });
  assert.equal(note.status, 202);
});

test("http: cross-tenant status lookup returns not found", async () => {
  const { url, store } = await httpHarness();
  const task = store.createTask({ tenantId: "tenant-a", userId: "alice", objective: "tenant a only", successCriteria: ["ok"] });
  const { client } = await httpClient(url, TOKEN_B);
  const res = await client.callTool("atlas.status_lookup", { taskId: task.id });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.error.code, "NOT_FOUND");
  const missing = await client.callTool("atlas.status_lookup", { taskId: "tsk_doesnotexist" });
  assert.deepEqual(missing, res, "indistinguishable from a missing task");
  assert.deepEqual((await client.callTool("atlas.list_tasks", {})).structuredContent.tasks, []);
});

test("gateway → Atlas MCP server over HTTP: scoped credential, round trip, token never audited", async () => {
  const { url, store, audit: serverAudit } = await httpHarness();
  const gatewayAudit = [];
  const vault = { "tenant-a/atlas/atlas:mcp": TOKEN_A };
  const gateway = new McpGateway({
    authorize: () => true,
    audit: (e) => gatewayAudit.push(e),
    credentialProvider: (tenantId, serverId, scope) => vault[`${tenantId}/${serverId}/${scope}`] ?? null,
  });
  cleanups.push(() => gateway.close());
  gateway.registerServer({ tenantId: "tenant-a", serverId: "atlas", credentialsScope: "atlas:mcp", allowedTools: ["atlas.*"], trust: "reviewed", http: { url, allowLoopback: true } });
  const ctx = { tenantId: "tenant-a", userId: "alice" };
  await gateway.discover("atlas", ctx);
  const created = await gateway.callTool(ctx, "atlas", "atlas.create_task", { objective: "Round trip", successCriteria: ["done"] });
  const id = created.structuredContent.task.id;
  const status = await gateway.callTool(ctx, "atlas", "atlas.status_lookup", { taskId: id });
  assert.equal(status.structuredContent.task.status, "proposed");
  assert.equal(store.getTask("tenant-a", id).objective, "Round trip");
  const all = JSON.stringify([gatewayAudit, serverAudit, created, status]);
  assert.ok(!all.includes(TOKEN_A), "token never in results or audit");
  assert.deepEqual(serverAudit.map((e) => [e.tool, e.outcome]), [["atlas.create_task", "success"], ["atlas.status_lookup", "success"]]);
  assert.deepEqual(gatewayAudit.filter((e) => e.type === "mcp.call").map((e) => e.outcome), ["success", "success"]);
});

test("stdio main refuses to start without its required configuration", async () => {
  const main = fileURLToPath(new URL("../src/platform/mcp-server/main-stdio.mjs", import.meta.url));
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({ version: "p", rules: [] }));
  const transport = createStdioTransport({ argv: [process.execPath, main], env: { ATLAS_MCP_POLICY: policy }, killGraceMs: 100 });
  const client = new McpClient({ transport, requestTimeoutMs: 3000 });
  await assert.rejects(client.initialize(), (e) => ["SERVER_EXITED", "TRANSPORT_CLOSED"].includes(e.code));
  await client.close();
});
