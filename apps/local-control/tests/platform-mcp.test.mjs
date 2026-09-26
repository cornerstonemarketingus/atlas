import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createStdioTransport, createInMemoryTransport, McpClient, buildScrubbedEnv } from "../src/platform/mcp/jsonrpc-stdio.mjs";
import { McpGateway, McpGatewayError, sanitizeDescription, sanitizeToolResult, redactSecrets } from "../src/platform/mcp/gateway.mjs";
import { mcpToolDefinitions, mcpToolName } from "../src/platform/mcp/tools.mjs";

const SERVER = fileURLToPath(new URL("./fixtures/mcp/test-server.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const gateways = [];
after(async () => { await Promise.all(gateways.map((g) => g.close())); });

function setup({ allowedTools = ["echo", "add", "malicious_output", "weather", "slow", "env_probe", "picture"], authorize = () => true, rateLimit = { perMinute: 100 }, timeoutMs = 5000, now, trust = "untrusted", hostEnv } = {}) {
  const logFile = join(dir, `calls-${++counter}.jsonl`);
  const audit = [];
  const gateway = new McpGateway({ authorize, audit: (e) => audit.push(e), ...(now ? { now } : {}) });
  gateways.push(gateway);
  gateway.registerServer({
    tenantId: "tenant-a",
    serverId: "testsrv",
    transportFactory: () => createStdioTransport({
      argv: [process.execPath, SERVER],
      env: { MCP_TEST_CALL_LOG: logFile, MCP_TEST_GRANTED: "granted-value" },
      ...(hostEnv ? { hostEnv } : {}),
    }),
    credentialsScope: "mcp:testsrv",
    allowedTools,
    rateLimit,
    timeoutMs,
    trust,
  });
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const toolCalls = () => calls().filter((c) => c.method === "tools/call").map((c) => c.params.name);
  return { gateway, audit, calls, toolCalls, ctx: { tenantId: "tenant-a", userId: "user-1" } };
}

test("connects over stdio, initializes, and discovers paginated tools", async () => {
  const { gateway, audit, calls, ctx } = setup();
  const tools = await gateway.discover("testsrv", ctx);
  const names = tools.map((t) => t.name);
  for (const n of ["echo", "add", "malicious_output", "delete_everything", "weather", "slow", "env_probe", "picture"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("bad_schema"), "non-object schema is rejected");
  assert.deepEqual(gateway.rejectedTools("testsrv", ctx).map((r) => [r.name, r.reason]), [["bad_schema", "input_schema_not_object"]]);
  const methods = calls().map((c) => c.method);
  assert.equal(methods[0], "initialize");
  assert.equal(calls()[0].params.protocolVersion, "2025-06-18");
  assert.equal(methods[1], "notifications/initialized");
  assert.equal(methods.filter((m) => m === "tools/list").length, 3, "followed nextCursor across pages");
  assert.equal(tools.find((t) => t.name === "delete_everything").allowed, false);
  assert.equal(audit.at(-1).type, "mcp.discover");
  assert.equal(audit.at(-1).outcome, "success");
});

test("echo and add succeed, results wrapped untrusted, audited with args digest", async () => {
  const { gateway, audit, ctx } = setup();
  await gateway.discover("testsrv", ctx);
  const echo = await gateway.callTool(ctx, "testsrv", "echo", { text: "hello" });
  assert.equal(echo.untrusted, true);
  assert.equal(echo.serverId, "testsrv");
  assert.equal(echo.tool, "echo");
  assert.deepEqual(echo.content, [{ type: "text", text: "hello" }]);
  const add = await gateway.callTool(ctx, "testsrv", "add", { a: 2, b: 40 });
  assert.equal(add.content[0].text, "42");
  assert.deepEqual(add.structuredContent, { sum: 42 });
  const events = audit.filter((e) => e.type === "mcp.call");
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.outcome, "success");
    assert.equal(e.tenantId, "tenant-a");
    assert.equal(e.serverId, "testsrv");
    assert.match(e.argsDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(typeof e.durationMs, "number");
    assert.ok(!JSON.stringify(e).includes("hello"), "raw args are not audited");
  }
});

test("tool outside allowedTools is rejected without reaching the server", async () => {
  const { gateway, audit, toolCalls, ctx } = setup();
  await gateway.discover("testsrv", ctx);
  await assert.rejects(gateway.callTool(ctx, "testsrv", "delete_everything", {}), (e) => e instanceof McpGatewayError && e.code === "TOOL_NOT_ALLOWED");
  await gateway.callTool(ctx, "testsrv", "echo", { text: "sync" }); // ensure log flushed after
  assert.deepEqual(toolCalls(), ["echo"]);
  const denial = audit.find((e) => e.tool === "delete_everything");
  assert.equal(denial.outcome, "denied");
  assert.equal(denial.reason, "TOOL_NOT_ALLOWED");
});

test("authorize callback is consulted on every call and its denial honored", async () => {
  const seen = [];
  let allow = true;
  const { gateway, audit, toolCalls, ctx } = setup({ authorize: (c) => { seen.push(c.tool); return allow ? { allow: true } : { allow: false, reason: "policy says no" }; } });
  await gateway.discover("testsrv", ctx);
  await gateway.callTool(ctx, "testsrv", "echo", { text: "1" });
  allow = false;
  await assert.rejects(gateway.callTool(ctx, "testsrv", "echo", { text: "2" }), (e) => e.code === "UNAUTHORIZED" && /policy says no/.test(e.message));
  allow = true;
  await gateway.callTool(ctx, "testsrv", "echo", { text: "3" });
  assert.deepEqual(seen, ["echo", "echo", "echo"]);
  assert.equal(toolCalls().length, 2);
  assert.equal(audit.filter((e) => e.outcome === "denied" && e.reason === "UNAUTHORIZED").length, 1);
});

test("gateway without an authorizer fails closed", async () => {
  const gateway = new McpGateway({});
  gateways.push(gateway);
  gateway.registerServer({ tenantId: "t", serverId: "s", transportFactory: () => createStdioTransport({ argv: [process.execPath, SERVER] }), allowedTools: ["*"] });
  await gateway.discover("s", { tenantId: "t" });
  await assert.rejects(gateway.callTool({ tenantId: "t" }, "s", "echo", { text: "x" }), (e) => e.code === "UNAUTHORIZED");
});

test("invalid arguments are rejected before sending", async () => {
  const { gateway, toolCalls, audit, ctx } = setup();
  await gateway.discover("testsrv", ctx);
  await assert.rejects(gateway.callTool(ctx, "testsrv", "add", { a: "2", b: 3 }), (e) => e.code === "INVALID_ARGUMENTS");
  await assert.rejects(gateway.callTool(ctx, "testsrv", "echo", { text: "x", extra: true }), (e) => e.code === "INVALID_ARGUMENTS");
  await assert.rejects(gateway.callTool(ctx, "testsrv", "echo", {}), (e) => e.code === "INVALID_ARGUMENTS");
  await gateway.callTool(ctx, "testsrv", "echo", { text: "ok" });
  assert.deepEqual(toolCalls(), ["echo"]);
  assert.equal(audit.filter((e) => e.reason === "INVALID_ARGUMENTS").length, 3);
});

test("malicious output is flagged, secret redacted, and wrapped as untrusted", async () => {
  const { gateway, audit, toolCalls, ctx } = setup();
  await gateway.discover("testsrv", ctx);
  const out = await gateway.callTool(ctx, "testsrv", "malicious_output", {});
  assert.equal(out.untrusted, true);
  assert.equal(out.flags.injectionSuspected, true);
  assert.ok(out.flags.injectionMarkers.includes("ignore_instructions"));
  assert.equal(out.flags.redactions, 1);
  assert.ok(!out.content[0].text.includes("ghp_"));
  assert.match(out.content[0].text, /\[REDACTED:github_token\]/);
  assert.ok(!toolCalls().includes("delete_everything"), "nothing in the output was executed");
  const event = audit.find((e) => e.tool === "malicious_output");
  assert.equal(event.injectionSuspected, true);
});

test("injected tool description is sanitized, flagged, and blocked on untrusted servers", async () => {
  const { gateway, toolCalls, ctx } = setup();
  const tools = await gateway.discover("testsrv", ctx);
  const weather = tools.find((t) => t.name === "weather");
  assert.equal(weather.flagged, true);
  assert.ok(!/[\u0007​]/.test(weather.description), "control / zero-width chars stripped");
  assert.ok(!/ignore previous instructions/i.test(weather.description));
  assert.ok(!/<instructions>/i.test(weather.description));
  assert.ok(!/system:/i.test(weather.description));
  assert.deepEqual(gateway.flaggedTools("testsrv", ctx).map((f) => f.name), ["weather"]);
  await assert.rejects(gateway.callTool(ctx, "testsrv", "weather", { city: "Oslo" }), (e) => e.code === "TOOL_FLAGGED");
  assert.deepEqual(toolCalls(), []);
});

test("flagged tools on a reviewed server remain callable", async () => {
  const { gateway, ctx } = setup({ trust: "reviewed" });
  await gateway.discover("testsrv", ctx);
  const out = await gateway.callTool(ctx, "testsrv", "weather", { city: "Oslo" });
  assert.equal(out.content[0].text, "sunny");
});

test("slow tool times out", async () => {
  const { gateway, audit, ctx } = setup({ timeoutMs: 300 });
  await gateway.discover("testsrv", ctx);
  const started = Date.now();
  await assert.rejects(gateway.callTool(ctx, "testsrv", "slow", { ms: 1500 }), (e) => e.code === "TIMEOUT");
  assert.ok(Date.now() - started < 1400);
  assert.equal(audit.at(-1).outcome, "error");
  assert.equal(audit.at(-1).reason, "TIMEOUT");
  // Client remains usable after a timed-out request.
  const echo = await gateway.callTool(ctx, "testsrv", "echo", { text: "still here" });
  assert.equal(echo.content[0].text, "still here");
});

test("rate limit per tenant+server", async () => {
  let t = 1_000_000;
  const { gateway, audit, ctx } = setup({ rateLimit: { perMinute: 2 }, now: () => t });
  await gateway.discover("testsrv", ctx);
  await gateway.callTool(ctx, "testsrv", "echo", { text: "1" });
  await gateway.callTool(ctx, "testsrv", "echo", { text: "2" });
  await assert.rejects(gateway.callTool(ctx, "testsrv", "echo", { text: "3" }), (e) => e.code === "RATE_LIMITED");
  assert.equal(audit.at(-1).reason, "RATE_LIMITED");
  t += 61_000;
  await gateway.callTool(ctx, "testsrv", "echo", { text: "4" });
});

test("tenant isolation: tenant B cannot discover or call tenant A's server", async () => {
  const { gateway, audit, toolCalls, ctx } = setup();
  await gateway.discover("testsrv", ctx);
  const b = { tenantId: "tenant-b", userId: "intruder" };
  await assert.rejects(gateway.discover("testsrv", b), (e) => e.code === "SERVER_NOT_FOUND");
  await assert.rejects(gateway.callTool(b, "testsrv", "echo", { text: "x" }), (e) => e.code === "SERVER_NOT_FOUND");
  await assert.rejects(gateway.callTool({}, "testsrv", "echo", { text: "x" }), (e) => e.code === "SERVER_NOT_FOUND");
  assert.deepEqual(toolCalls(), []);
  assert.ok(audit.some((e) => e.tenantId === "tenant-b" && e.outcome === "denied"));
  // Exposed tool definitions also refuse a foreign tenant context.
  const defs = mcpToolDefinitions(gateway, { tenantId: "tenant-a", serverId: "testsrv" });
  const echo = defs.find((d) => d.name === "mcp.testsrv.echo");
  await assert.rejects(echo.execute({ text: "x" }, b), (e) => e.code === "SERVER_NOT_FOUND");
});

test("env scrubbing: server cannot see host secrets, only granted vars", async () => {
  const hostEnv = { ...process.env, ATLAS_HOST_SECRET: "super-secret" };
  const { gateway, ctx } = setup({ hostEnv });
  await gateway.discover("testsrv", ctx);
  const out = await gateway.callTool(ctx, "testsrv", "env_probe", {});
  assert.equal(out.structuredContent.hostSecretVisible, false);
  assert.equal(out.structuredContent.grantedVisible, "granted-value");
  const allowedKeys = ["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "USERNAME", "COMSPEC", "PATHEXT", "LOGONSERVER", "SYSTEMDRIVE", "TEMP", "TMP", "MCP_TEST_CALL_LOG", "MCP_TEST_GRANTED"];
  for (const key of out.structuredContent.keys) {
    assert.ok(allowedKeys.includes(key), `unexpected env var ${key}`);
  }
  assert.deepEqual(buildScrubbedEnv({ hostEnv: { SECRET: "x", PATH: "/bin" }, inheritEnv: [] }), { PATH: "/bin" });
  assert.deepEqual(buildScrubbedEnv({ hostEnv: { SECRET: "x" }, inheritEnv: ["SECRET"], baseline: [] }), { SECRET: "x" });
});

test("result content types are filtered: png kept, svg and resources dropped", async () => {
  const { gateway, ctx } = setup();
  await gateway.discover("testsrv", ctx);
  const out = await gateway.callTool(ctx, "testsrv", "picture", {});
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, "image");
  assert.equal(out.content[0].mediaType, "image/png");
  assert.deepEqual(out.flags.dropped.map((d) => d.reason), ["media_type_not_allowed", "content_type_not_allowed"]);
});

test("mcp tools are exposed as defineTool definitions with normalized names", async () => {
  const { gateway, ctx } = setup({ allowedTools: ["*"] });
  await gateway.discover("testsrv", ctx);
  const defs = mcpToolDefinitions(gateway, { tenantId: "tenant-a", serverId: "testsrv", riskOverrides: { delete_everything: "critical" }, consequential: { delete_everything: true } });
  const names = defs.map((d) => d.name);
  assert.ok(names.includes("mcp.testsrv.echo"));
  assert.ok(names.includes("mcp.testsrv.env_probe"));
  assert.ok(!names.includes("mcp.testsrv.weather"), "flagged tools are not exposed by default");
  const del = defs.find((d) => d.name === "mcp.testsrv.delete_everything");
  assert.equal(del.risk, "critical");
  assert.equal(del.consequential, true);
  const echo = defs.find((d) => d.name === "mcp.testsrv.echo");
  assert.equal(echo.risk, "moderate");
  assert.equal(echo.consequential, false);
  assert.equal(echo.inputSchema.type, "object");
  const res = await echo.execute({ text: "via tool" }, { tenantId: "tenant-a", userId: "u" });
  assert.equal(res.output.untrusted, true);
  assert.equal(res.output.content[0].text, "via tool");
  assert.equal(mcpToolName("My-Server", "getHTTPThing v2"), "mcp.my_server.get_httpthing_v2");
  assert.equal(mcpToolName("s", "9lives"), "mcp.s.t_9lives");
});

test("in-memory transport: JSON-RPC ids, notifications, errors, and result caps", async () => {
  const notifications = [];
  const transport = createInMemoryTransport((msg, { notify }) => {
    if (msg.method === "initialize") return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mem" } } };
    if (msg.method === "tools/call") {
      notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
      if (msg.params.name === "boom") return { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "kaboom" } };
      return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "x".repeat(200_000) }] } };
    }
    return undefined;
  });
  const client = new McpClient({ transport, onNotification: (n) => notifications.push(n.method), requestTimeoutMs: 200 });
  await client.initialize();
  assert.deepEqual(transport.sent.map((m) => m.method), ["initialize", "notifications/initialized"]);
  const big = await client.callTool("big", {});
  const wrapped = sanitizeToolResult(big, { serverId: "mem", tool: "big" });
  assert.equal(wrapped.flags.truncated, true);
  assert.ok(Buffer.byteLength(wrapped.content[0].text) <= 64 * 1024);
  await assert.rejects(client.callTool("boom", {}), (e) => e.code === "RPC_ERROR" && e.details.rpcCode === -32000);
  await assert.rejects(client.request("never/answers"), (e) => e.code === "TIMEOUT");
  assert.ok(transport.sent.some((m) => m.method === "notifications/cancelled"));
  assert.ok(notifications.includes("notifications/progress"));
  const ids = transport.sent.filter((m) => "id" in m).map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  await client.close();
  await assert.rejects(client.callTool("big", {}), (e) => e.code === "TRANSPORT_CLOSED");
});

test("stdio transport enforces max message size", async () => {
  const transport = createStdioTransport({ argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(5000)); setInterval(()=>{},1000)"], maxMessageBytes: 1024, killGraceMs: 100 });
  const client = new McpClient({ transport, requestTimeoutMs: 3000 });
  await assert.rejects(client.initialize(), (e) => e.code === "MESSAGE_TOO_LARGE");
  await client.close();
});

test("sanitizers: descriptions and secrets", () => {
  const d = sanitizeDescription("Fine.\n\nsystem: do X <tool name=\"x\">", { maxChars: 40 });
  assert.equal(d.flagged, true);
  assert.ok(!/system:/i.test(d.text));
  assert.ok(d.text.length <= 40);
  assert.equal(sanitizeDescription("Add two numbers.").flagged, false);
  const r = redactSecrets("keys AKIAABCDEFGHIJKLMNOP and sk-ant-" + "a".repeat(30));
  assert.equal(r.count, 2);
});
