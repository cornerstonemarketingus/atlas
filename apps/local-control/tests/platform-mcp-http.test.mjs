import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpClient, createStdioTransport } from "../src/platform/mcp/jsonrpc-stdio.mjs";
import { createStreamableHttpTransport, assertSafeUrl, classifyAddress, guardedLookup, createSseParser } from "../src/platform/mcp/http-transport.mjs";
import { McpGateway } from "../src/platform/mcp/gateway.mjs";
import { startTestHttpServer } from "./fixtures/mcp/http-test-server.mjs";

const TOKEN = "tok_live_0123456789abcdefSECRET";
const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function server(opts) {
  const s = await startTestHttpServer(opts);
  cleanups.push(() => s.close());
  return s;
}

function gatewayFor(url, { provider, scope = "mcp:remote", allowedTools = ["*"], timeoutMs = 3000, backoff = 1, sleeps } = {}) {
  const audit = [];
  const gateway = new McpGateway({
    authorize: () => true,
    audit: (e) => audit.push(e),
    credentialProvider: provider,
    sleep: async (ms) => { sleeps?.push(ms); },
  });
  cleanups.push(() => gateway.close());
  gateway.registerServer({
    tenantId: "tenant-a", serverId: "remote", credentialsScope: scope, allowedTools, timeoutMs,
    reconnectBackoffMs: backoff, trust: "reviewed",
    http: { url, allowLoopback: true },
  });
  return { gateway, audit, ctx: { tenantId: "tenant-a", userId: "u1" } };
}

const exactProvider = (tenant, serverId, scope) => (tenant === "tenant-a" && serverId === "remote" && scope === "mcp:remote" ? TOKEN : null);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

for (const mode of ["json", "sse"]) {
  test(`http client (${mode}): initialize, session id, protocol header, tools, notifications`, async () => {
    const s = await server({ mode, token: TOKEN });
    const notes = [];
    const transport = createStreamableHttpTransport({ url: s.url, allowLoopback: true, getToken: () => TOKEN });
    const client = new McpClient({ transport, requestTimeoutMs: 3000, onNotification: (n) => notes.push(n.method) });
    const init = await client.initialize();
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.match(transport.sessionId, /^[0-9a-f-]{36}$/);
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["echo", "whoami", "big", "slow"]);
    const echo = await client.callTool("echo", { text: "hi there" });
    assert.equal(echo.content[0].text, "hi there");
    const [initReq, ...rest] = s.state.requests;
    assert.equal(initReq.rpc, "initialize");
    assert.equal(initReq.headers["mcp-session-id"], undefined);
    assert.match(initReq.headers.accept, /application\/json/);
    assert.match(initReq.headers.accept, /text\/event-stream/);
    for (const r of rest) {
      assert.equal(r.headers["mcp-session-id"], transport.sessionId);
      assert.equal(r.headers["mcp-protocol-version"], "2025-06-18");
      assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
    }
    assert.ok(rest.some((r) => r.rpc === "notifications/initialized"));
    if (mode === "sse") assert.ok(notes.includes("notifications/progress"));
    await client.close();
    assert.equal(s.state.requests.at(-1).method, "DELETE");
  });
}

test("http client enforces max response size and timeout", async () => {
  const s = await server({ mode: "json" });
  const transport = createStreamableHttpTransport({ url: s.url, allowLoopback: true, maxResponseBytes: 50_000, timeoutMs: 300 });
  const client = new McpClient({ transport, requestTimeoutMs: 5000 });
  await client.initialize();
  await assert.rejects(client.callTool("big", {}), (e) => e.code === "MESSAGE_TOO_LARGE");
  const started = Date.now();
  await assert.rejects(client.callTool("slow", { ms: 2000 }), (e) => e.code === "TIMEOUT");
  assert.ok(Date.now() - started < 1500);
  assert.equal((await client.callTool("echo", { text: "ok" })).content[0].text, "ok");
  await client.close();
});

test("http client: 401 is AUTH_FAILED and never echoes the token", async () => {
  const s = await server({ token: TOKEN });
  const transport = createStreamableHttpTransport({ url: s.url, allowLoopback: true, getToken: () => "tok_wrong_0123456789abcdef" });
  const client = new McpClient({ transport, requestTimeoutMs: 3000 });
  await assert.rejects(client.initialize(), (e) => e.code === "AUTH_FAILED" && !e.message.includes("tok_"));
  await client.close();
});

test("sse parser handles multi-line data, comments, CRLF and split chunks", () => {
  const events = [];
  const p = createSseParser((e) => events.push(e));
  p.push(": hi\r\nevent: message\r\ndata: {\"a\":\r\n");
  p.push("data: 1}\r\n\r\ndata: x");
  p.end();
  assert.deepEqual(events.map((e) => e.data), ["{\"a\":\n1}", "x"]);
});

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

test("SSRF: refuses non-https, loopback without opt-in, private and metadata addresses", () => {
  const blocked = (url, opts) => assert.throws(() => assertSafeUrl(url, opts), (e) => e.code === "SSRF_BLOCKED", url);
  blocked("http://example.com/mcp");
  blocked("ftp://example.com/mcp");
  blocked("file:///etc/passwd");
  blocked("http://127.0.0.1:9/mcp");                       // loopback not allowed
  blocked("https://127.0.0.1/mcp");
  blocked("https://localhost/mcp");
  blocked("http://10.0.0.5/mcp", { allowLoopback: true });  // http to non-loopback
  blocked("https://10.0.0.5/mcp");
  blocked("https://192.168.1.10/mcp");
  blocked("https://172.20.0.1/mcp");
  blocked("https://169.254.169.254/latest/meta-data");
  blocked("https://100.64.0.1/mcp");
  blocked("https://[::1]/mcp");
  blocked("https://[fd00::1]/mcp");
  blocked("https://[fe80::1]/mcp");
  blocked("https://[::ffff:10.0.0.1]/mcp");
  blocked("https://[::ffff:127.0.0.1]/mcp");
  blocked("https://user:pass@example.com/mcp");
  assert.equal(assertSafeUrl("https://example.com/mcp").hostname, "example.com");
  assert.equal(assertSafeUrl("https://8.8.8.8/mcp").hostname, "8.8.8.8");
  assert.equal(assertSafeUrl("http://127.0.0.1:8080/mcp", { allowLoopback: true }).port, "8080");
  assert.equal(assertSafeUrl("https://10.0.0.5/mcp", { allowPrivateHosts: ["10.0.0.5"] }).hostname, "10.0.0.5");
  assert.equal(classifyAddress("172.15.255.255"), "public");
  assert.equal(classifyAddress("172.16.0.0"), "private");
  assert.equal(classifyAddress("2606:4700::1111"), "public");
});

test("SSRF: hostnames resolving to private addresses are refused at connect time unless allowlisted", async () => {
  const fakeDns = (map) => (host, _opts, cb) => cb(null, (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  const lookup = fakeDns({ "internal.corp.test": ["10.1.2.3"], "rebind.test": ["93.184.216.34", "127.0.0.1"], "ok.test": ["93.184.216.34"] });
  const resolve = (host, opts) => new Promise((res, rej) => guardedLookup({ ...opts, lookup })(host, { all: true }, (e, a) => (e ? rej(e) : res(a))));
  await assert.rejects(resolve("internal.corp.test", {}), (e) => e.code === "SSRF_BLOCKED");
  await assert.rejects(resolve("rebind.test", {}), (e) => e.code === "SSRF_BLOCKED");
  assert.deepEqual((await resolve("internal.corp.test", { allowPrivateHosts: ["internal.corp.test"] })).map((a) => a.address), ["10.1.2.3"]);
  assert.deepEqual((await resolve("ok.test", {})).map((a) => a.address), ["93.184.216.34"]);

  // End to end: a transport to a hostname that resolves to a private address never connects.
  const transport = createStreamableHttpTransport({ url: "https://internal.corp.test/mcp", lookup });
  const client = new McpClient({ transport, requestTimeoutMs: 3000 });
  await assert.rejects(client.initialize(), (e) => e.code === "SSRF_BLOCKED");
  await client.close();
});

test("SSRF: gateway refuses to register an unsafe http server", () => {
  const gateway = new McpGateway({ authorize: () => true });
  assert.throws(() => gateway.registerServer({ tenantId: "t", serverId: "x", http: { url: "http://example.com/mcp" }, allowedTools: ["*"] }), (e) => e.code === "SSRF_BLOCKED");
  assert.throws(() => gateway.registerServer({ tenantId: "t", serverId: "y", http: { url: "https://169.254.169.254/" }, allowedTools: ["*"] }), (e) => e.code === "SSRF_BLOCKED");
});

// ---------------------------------------------------------------------------
// Credential scope enforcement
// ---------------------------------------------------------------------------

test("credentials: resolved only via provider with the registration's tenant/server/scope; never in results or audit", async () => {
  const s = await server({ mode: "json", token: TOKEN });
  const seen = [];
  const provider = (...args) => { seen.push(args); return exactProvider(...args); };
  const { gateway, audit, ctx } = gatewayFor(s.url, { provider });
  await gateway.discover("remote", ctx);
  const out = await gateway.callTool(ctx, "remote", "whoami", {});
  // The server saw the token, but the caller only sees a redaction.
  assert.equal(out.content[0].text, "auth=Bearer [REDACTED:credential]");
  assert.ok(out.flags.redactions >= 1);
  for (const args of seen) assert.deepEqual(args, ["tenant-a", "remote", "mcp:remote"]);
  assert.ok(!JSON.stringify(audit).includes(TOKEN), "token never audited");
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  assert.ok(!JSON.stringify(gateway.serverInfo("remote", ctx)).includes(TOKEN));
});

test("credentials: wrong scope yields no credential and the call is denied before any request", async () => {
  const s = await server({ mode: "json", token: TOKEN });
  const { gateway, audit, ctx } = gatewayFor(s.url, { provider: exactProvider, scope: "mcp:other-scope" });
  await assert.rejects(gateway.discover("remote", ctx), (e) => e.code === "CREDENTIAL_UNAVAILABLE");
  assert.equal(s.state.requests.length, 0, "nothing reached the server");

  // A credential revoked after discovery: the next call is denied before sending.
  let revoked = false;
  const { gateway: g3, audit: a3 } = gatewayFor(s.url, { provider: (...a) => (revoked ? null : exactProvider(...a)) });
  await g3.discover("remote", ctx);
  const before = s.state.requests.filter((r) => r.rpc === "tools/call").length;
  revoked = true;
  await assert.rejects(g3.callTool(ctx, "remote", "echo", { text: "x" }), (e) => e.code === "CREDENTIAL_UNAVAILABLE");
  assert.equal(s.state.requests.filter((r) => r.rpc === "tools/call").length, before);
  assert.equal(a3.at(-1).reason, "CREDENTIAL_UNAVAILABLE");
  const sent = s.state.requests.length;
  assert.ok(audit.every((e) => e.outcome === "denied" && e.reason === "CREDENTIAL_UNAVAILABLE"));

  // No provider at all also fails closed.
  const g2 = new McpGateway({ authorize: () => true });
  cleanups.push(() => g2.close());
  g2.registerServer({ tenantId: "tenant-a", serverId: "remote", credentialsScope: "mcp:remote", allowedTools: ["*"], http: { url: s.url, allowLoopback: true } });
  await assert.rejects(g2.discover("remote", { tenantId: "tenant-a" }), (e) => e.code === "CREDENTIAL_UNAVAILABLE");
  assert.equal(s.state.requests.length, sent);
});

test("credentials: a provider that throws or returns a token for another tenant is not used", async () => {
  const s = await server({ mode: "json", token: TOKEN });
  const { gateway, ctx } = gatewayFor(s.url, { provider: () => { throw new Error(`vault error containing ${TOKEN}`); } });
  await assert.rejects(gateway.discover("remote", ctx), (e) => e.code === "CREDENTIAL_UNAVAILABLE" && !e.message.includes(TOKEN));
  // Tenant B asking for tenant A's server never reaches the provider.
  let calls = 0;
  const { gateway: g2 } = gatewayFor(s.url, { provider: (...a) => { calls += 1; return exactProvider(...a); } });
  await assert.rejects(g2.discover("remote", { tenantId: "tenant-b" }), (e) => e.code === "SERVER_NOT_FOUND");
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

test("reconnect: an expired HTTP session is re-initialized once and the call retried", async () => {
  const s = await server({ mode: "sse", token: TOKEN });
  const sleeps = [];
  const { gateway, ctx } = gatewayFor(s.url, { provider: exactProvider, backoff: 5, sleeps });
  await gateway.discover("remote", ctx);
  assert.equal(s.state.initializeCount, 1);
  s.rotate(); // server forgets every session (e.g. restarted)
  const out = await gateway.callTool(ctx, "remote", "echo", { text: "after restart" });
  assert.equal(out.content[0].text, "after restart");
  assert.equal(s.state.initializeCount, 2);
  assert.deepEqual(sleeps, [5], "backoff applied once");
});

test("reconnect: at most one re-creation per call", async () => {
  const s = await server({ mode: "json", token: TOKEN });
  const sleeps = [];
  const { gateway, audit, ctx } = gatewayFor(s.url, { provider: exactProvider, sleeps });
  await gateway.discover("remote", ctx);
  s.state.expireAlways = true;
  await assert.rejects(gateway.callTool(ctx, "remote", "echo", { text: "x" }), (e) => e.code === "CALL_FAILED" && e.details.cause === "SESSION_EXPIRED");
  assert.equal(s.state.initializeCount, 2, "exactly one reconnect");
  assert.equal(sleeps.length, 1);
  assert.equal(audit.at(-1).reason, "SESSION_EXPIRED");
  s.state.expireAlways = false;
  // Next call recovers (client from the retry is healthy or re-created once more).
  assert.equal((await gateway.callTool(ctx, "remote", "echo", { text: "back" })).content[0].text, "back");
});

test("reconnect: a stdio server that died is re-created (with backoff) on the next call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-rc-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.jsonl");
  const SERVER = fileURLToPath(new URL("./fixtures/mcp/test-server.mjs", import.meta.url));
  const sleeps = [];
  const gateway = new McpGateway({ authorize: () => true, sleep: async (ms) => { sleeps.push(ms); } });
  cleanups.push(() => gateway.close());
  gateway.registerServer({
    tenantId: "t", serverId: "s", allowedTools: ["echo"], reconnectBackoffMs: 50,
    transportFactory: () => createStdioTransport({ argv: [process.execPath, SERVER], env: { MCP_TEST_CALL_LOG: log } }),
  });
  const ctx = { tenantId: "t" };
  await gateway.discover("s", ctx);
  const entry = gateway.servers.get(McpGateway.key("t", "s"));
  const dying = entry.client;
  process.kill(dying.transport.pid, "SIGKILL");
  for (let i = 0; i < 200 && !dying.closed; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(dying.closed, true, "client noticed the server died");
  const out = await gateway.callTool(ctx, "s", "echo", { text: "revived" });
  assert.equal(out.content[0].text, "revived");
  assert.deepEqual(sleeps, [50]);
  const inits = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.method === "initialize");
  assert.equal(inits.length, 2);
  assert.ok(existsSync(log));
});

test("reconnect: a server that stays down fails after one retry", async () => {
  const s = await server({ mode: "json", token: TOKEN });
  const sleeps = [];
  const { gateway, ctx } = gatewayFor(s.url, { provider: exactProvider, sleeps });
  await gateway.discover("remote", ctx);
  await s.close();
  await assert.rejects(gateway.callTool(ctx, "remote", "echo", { text: "x" }), (e) => e.code === "CALL_FAILED");
  assert.ok(sleeps.length <= 1);
});
