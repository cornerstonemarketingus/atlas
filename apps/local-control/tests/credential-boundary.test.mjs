import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { adaptRegistryTool } from "../src/platform/adapters.mjs";
import { AuthorizedToolExecutor, PlatformTaskStore, PolicyEngine } from "../src/platform/index.mjs";

test("legacy registry timeout aborts a delayed credential lookup before action", async () => {
  let effects = 0;
  const registry = new ToolRegistry({ policy: () => "allow", secrets: async () => { await new Promise(resolve => setTimeout(resolve, 80)); return "opaque-value"; } });
  registry.register({ name: "slow.action", description: "Test", capability: "service.read", risk: "low", credentials: ["SERVICE_TOKEN"], timeoutMs: 20, retries: 0, maxOutputCharacters: 1024, requiresApproval: false,
    inputSchema: { type: "object", properties: {} }, execute: async () => { effects += 1; return "done"; } });
  const out = await registry.invoke({ name: "slow.action", rawArguments: {}, sessionId: "test" });
  assert.equal(out.code, "TOOL_TIMEOUT");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(effects, 0);
});

test("legacy registry refuses plaintext credentials before policy and receipt", async () => {
  let effects = 0;
  const registry = new ToolRegistry({ policy: () => { effects += 1; return "allow"; } });
  registry.register({ name: "input.action", description: "Test", capability: "service.read", risk: "low", timeoutMs: 1000, maxOutputCharacters: 1024, requiresApproval: false,
    inputSchema: { type: "object", properties: { token: { type: "string" } } }, execute: async () => { effects += 1; } });
  const out = await registry.invoke({ name: "input.action", rawArguments: { token: "opaque-secret" }, sessionId: "test" });
  assert.equal(out.code, "PLAINTEXT_CREDENTIAL");
  assert.equal(JSON.stringify(out).includes("opaque-secret"), false);
  assert.equal(effects, 0);
});

test("credential-shaped error codes and invalid property names are redacted", async () => {
  const value = `AKIA${"A".repeat(16)}`;
  const registry = new ToolRegistry({ policy: () => "allow", secrets: async () => value });
  registry.register({ name: "error.action", description: "Test", capability: "service.read", risk: "low", timeoutMs: 1000, maxOutputCharacters: 1024, requiresApproval: false, credentials: ["SERVICE_TOKEN"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { const error = new Error("Failed"); error.code = value; throw error; } });
  const out = await registry.invoke({ name: "error.action", rawArguments: {}, sessionId: "test" });
  assert.equal(out.code, "TOOL_FAILED");
  assert.equal(JSON.stringify(out).includes(value), false);
  const invalid = await registry.invoke({ name: "error.action", rawArguments: { [`gsk_${"x".repeat(32)}`]: true }, sessionId: "test" });
  assert.equal(invalid.code, "INVALID_INPUT");
  assert.equal(JSON.stringify(invalid).includes(`gsk_${"x".repeat(32)}`), false);
});

async function harness(t, { secrets, execute, credentialNames = ["SERVICE_TOKEN"], timeoutMs = 1000 }) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-credentials-"));
  let now = Date.now();
  const clock = () => new Date(now);
  const store = new PlatformTaskStore(join(directory, "tasks.sqlite"), { clock });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const task = store.createTask({ tenantId: "tenant-a", userId: "user-a", objective: "Invoke an approved service", successCriteria: ["The call works"] });
  store.transitionTask("tenant-a", task.id, "authorized");
  store.transitionTask("tenant-a", task.id, "queued");
  store.transitionTask("tenant-a", task.id, "running");
  const registry = new ToolRegistry({ secrets, policy: () => "deny" });
  registry.register({ name: "service.invoke", description: "Invoke service", capability: "service.read", risk: "moderate", requiresApproval: true,
    credentials: credentialNames, timeoutMs, maxOutputCharacters: 2048,
    inputSchema: { type: "object", properties: {} }, execute });
  const executor = new AuthorizedToolExecutor({ store, clock, policy: new PolicyEngine({ version: "credential-boundary.1", rules: [] }) });
  const adapted = adaptRegistryTool(registry.get("service.invoke"));
  executor.register(adapted.tool, { timeoutMs: adapted.timeoutMs });
  const args = { tenantId: "tenant-a", userId: "user-a", taskId: task.id, tool: "service.invoke", input: {}, grantedPermissions: ["service.*"] };
  const approve = async () => {
    const requested = await executor.invoke(args);
    assert.equal(requested.status, "awaiting_approval");
    store.resolveApproval("tenant-a", requested.approvalId, { decision: "approved", resolvedBy: "user-a" });
    return requested.approvalId;
  };
  return { store, registry, executor, args, approve, advance: ms => { now += ms; } };
}

test("declared credentials reach only the approved adapter and are scrubbed before persistence", async t => {
  const value = "opaque-local-service-secret";
  const asked = [];
  const h = await harness(t, { secrets: async (name, context) => { asked.push({ name, context }); return value; },
    execute: async ({ credentials, context, digest }) => {
      assert.equal(credentials.SERVICE_TOKEN, value);
      assert.equal(context.tenantId, "tenant-a");
      assert.match(digest, /^[0-9a-f]{64}$/u);
      return { answer: value, nested: { token: "new-opaque-credential", credentialRef: "SERVICE_TOKEN" } };
    } });
  assert.equal(JSON.stringify(h.registry.toModelTools()).includes("SERVICE_TOKEN"), false);
  const approvalId = await h.approve();
  assert.equal(asked.length, 0, "approval preparation must not read the vault");
  const result = await h.executor.invoke({ ...h.args, approvalId });
  assert.equal(result.status, "succeeded");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].context.capability, "service.read");
  const all = JSON.stringify({ result, calls: h.store.getToolCalls("tenant-a", h.args.taskId), events: h.store.listEvents("tenant-a") });
  assert.equal(all.includes(value), false);
  assert.equal(all.includes("new-opaque-credential"), false);
  assert.ok(all.includes("SERVICE_TOKEN"), "references may be visible");
});

test("denied capabilities cannot trigger vault reads", async t => {
  let reads = 0;
  const h = await harness(t, { secrets: () => { reads++; return "secret"; }, execute: () => { throw new Error("must not run"); } });
  assert.equal((await h.executor.invoke({ ...h.args, grantedPermissions: [] })).status, "denied");
  assert.equal(reads, 0);
});

test("missing or failing credentials refuse execution without leaking vault errors", async t => {
  let ran = false;
  const h = await harness(t, { secrets: () => null, execute: () => { ran = true; } });
  const approvalId = await h.approve();
  const result = await h.executor.invoke({ ...h.args, approvalId });
  assert.equal(result.result.error.code, "MISSING_CREDENTIAL");
  assert.equal(ran, false);
  const failure = await harness(t, { secrets: () => { throw new Error("opaque-secret-in-vault-error"); }, execute: () => { ran = true; } });
  const failed = await failure.executor.invoke({ ...failure.args, approvalId: await failure.approve() });
  assert.equal(failed.result.error.code, "CREDENTIAL_UNAVAILABLE");
  assert.equal(JSON.stringify(failed).includes("opaque-secret-in-vault-error"), false);
});

test("short passwords and thrown adapter errors are scrubbed without changing structured output", async t => {
  const h = await harness(t, { secrets: () => "short!", execute: () => { throw new Error("Service refused short!"); } });
  const result = await h.executor.invoke({ ...h.args, approvalId: await h.approve() });
  assert.equal(result.status, "failed");
  assert.equal(JSON.stringify(result).includes("short!"), false);
  assert.match(result.result.error.message, /redacted/u);
});

test("real authenticated HTTP executes after approval and never echoes its bearer into model output", async t => {
  const value = "boundary-test-service-credential";
  const received = [];
  const server = createServer((req, res) => {
    received.push(req.headers.authorization);
    res.writeHead(req.headers.authorization === `Bearer ${value}` ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ answer: "OK", echoedAuthorization: req.headers.authorization }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const h = await harness(t, { secrets: () => value, execute: async ({ credentials, signal }) => {
    const response = await fetch(endpoint, { headers: { authorization: `Bearer ${credentials.SERVICE_TOKEN}` }, signal });
    assert.equal(response.status, 200);
    return response.json();
  } });
  const approvalId = await h.approve();
  assert.equal(received.length, 0);
  const result = await h.executor.invoke({ ...h.args, approvalId });
  assert.equal(result.result.output.answer, "OK");
  assert.deepEqual(received, [`Bearer ${value}`]);
  assert.equal(JSON.stringify(result).includes(value), false);
});

test("raw definitions with credentials cannot bypass the registered resolver", async () => {
  const raw = adaptRegistryTool({ name: "service.raw", description: "Raw", capability: "service.read", risk: "low", credentials: ["SERVICE_TOKEN"], inputSchema: { type: "object", properties: {} }, execute: () => "must not run" });
  await assert.rejects(raw.tool.execute({}, { taskId: "test" }), { code: "MISSING_CREDENTIAL" });
});

test("cancelling a task during vault lookup prevents the external action", async t => {
  let h; let ran = false;
  h = await harness(t, { secrets: async () => {
    await Promise.resolve();
    h.store.transitionTask("tenant-a", h.args.taskId, "cancelled");
    return "opaque-service-credential";
  }, execute: () => { ran = true; } });
  const result = await h.executor.invoke({ ...h.args, approvalId: await h.approve() });
  assert.equal(result.result.error.code, "POLICY_DENIED");
  assert.equal(ran, false);
});

test("approval expiring during vault lookup cannot execute after preparation", async t => {
  let h; let approvalId; let ran = false;
  h = await harness(t, { secrets: async () => {
    await Promise.resolve();
    h.advance(25 * 60 * 60 * 1000);
    return "opaque-service-credential";
  }, execute: () => { ran = true; } });
  approvalId = await h.approve();
  const result = await h.executor.invoke({ ...h.args, approvalId });
  assert.equal(result.result.error.code, "POLICY_DENIED");
  assert.equal(ran, false);
});

test("a slow vault cannot execute an external action after its timeout", async t => {
  let ran = false;
  const h = await harness(t, { timeoutMs: 20, secrets: async () => {
    await new Promise(resolve => setTimeout(resolve, 75));
    return "opaque-service-credential";
  }, execute: () => { ran = true; } });
  const result = await h.executor.invoke({ ...h.args, approvalId: await h.approve() });
  assert.equal(result.result.error.code, "TIMEOUT");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(ran, false);
});
