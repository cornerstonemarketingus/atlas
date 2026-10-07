import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { idempotencyKey } from "../../../packages/atlas-contracts/src/index.mjs";
import { AuthorizedToolExecutor, PlatformTaskStore, PolicyEngine } from "../src/platform/index.mjs";

async function fixture(t, { consequential = true, execute = async () => ({ output: "done" }), knownSecrets = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-approval-boundary-"));
  const filename = join(directory, "tasks.sqlite");
  let now = Date.parse("2030-01-01T00:00:00Z");
  const clock = () => new Date(now);
  let store = new PlatformTaskStore(filename, { clock });
  const policy = new PolicyEngine({ version: "boundary.1", rules: [] });
  const repository = { repository: "repo-a", revision: "commit-a" };
  const makeExecutor = () => {
    const executor = new AuthorizedToolExecutor({ store, policy, clock, approvalTtlMs: 1000, approvalContext: () => repository, knownSecrets });
    executor.register({ name: "demo.action", description: "Test action", risk: consequential ? "high" : "read", consequential,
      inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false }, execute });
    return executor;
  };
  let executor = makeExecutor();
  const task = store.createTask({ tenantId: "a", userId: "owner", agentId: "agent", objective: "Test", successCriteria: ["Complete"], budget: { toolCalls: 20 } });
  for (const state of ["authorized", "queued", "running"]) store.transitionTask("a", task.id, state);
  const request = { tenantId: "a", userId: "owner", agentId: "agent", taskId: task.id, tool: "demo.action", input: { text: "safe" }, grantedPermissions: ["demo.action"] };
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { filename, repository, policy, request, get store() { return store; }, get executor() { return executor; },
    advance(ms) { now += ms; },
    reopen() { store.close(); store = new PlatformTaskStore(filename, { clock }); executor = makeExecutor(); },
    async approve() { const out = await executor.invoke(request); assert.equal(out.status, "awaiting_approval"); store.resolveApproval("a", out.approvalId, { decision: "approved", resolvedBy: "owner" }); return out.approvalId; },
  };
}

test("approved approvals expire and cannot be consumed at the deadline", async (t) => {
  const h = await fixture(t);
  const id = await h.approve();
  h.advance(1000);
  assert.equal(h.store.getApproval("a", id).status, "expired");
  assert.equal(h.store.consumeApproval("a", id, "call-a"), false);
  assert.equal((await h.executor.invoke({ ...h.request, approvalId: id })).status, "denied");
});

test("legacy persisted action receipts prevent external actions after upgrade", async (t) => {
  let runs = 0;
  const h = await fixture(t, { consequential: false, execute: async () => { runs += 1; return { output: "done" }; } });
  const key = idempotencyKey(h.request);
  const call = h.store.recordToolCall({ ...h.request, status: "requested", idempotencyKey: key });
  assert.equal(h.store.claimIdempotency({ tenantId: "a", taskId: h.request.taskId, key, toolCallId: call.id }), true);
  h.reopen();
  const out = await h.executor.invoke(h.request);
  assert.equal(out.status, "denied");
  assert.equal(out.result.error.code, "LEGACY_ACTION_RECEIPT");
  assert.equal(runs, 0);
});

test("expiry between approval precheck and atomic consumption prevents execution", async (t) => {
  let runs = 0;
  const h = await fixture(t, { execute: async () => { runs += 1; return "done"; } });
  const id = await h.approve();
  const evaluate = h.policy.evaluate.bind(h.policy);
  h.policy.evaluate = (request) => { const decision = evaluate(request); h.advance(1000); return decision; };
  const out = await h.executor.invoke({ ...h.request, approvalId: id });
  assert.equal(out.status, "denied");
  assert.equal(runs, 0);
  assert.equal(h.store.getApproval("a", id).consumedBy, null);
});

test("approval cannot cross principals, agents, repositories or revisions", async (t) => {
  const h = await fixture(t);
  const id = await h.approve();
  for (const override of [{ userId: "other" }, { agentId: "other-agent" }]) {
    assert.equal((await h.executor.invoke({ ...h.request, ...override, approvalId: id })).status, "denied");
  }
  h.repository.repository = "repo-b";
  assert.equal((await h.executor.invoke({ ...h.request, approvalId: id })).status, "denied");
  h.repository.repository = "repo-a";
  h.repository.revision = "commit-b";
  assert.equal((await h.executor.invoke({ ...h.request, approvalId: id })).status, "denied");
  h.repository.revision = "commit-a";
  assert.equal((await h.executor.invoke({ ...h.request, approvalId: id })).status, "succeeded");
});

test("trusted context changes during preparation fail closed", async (t) => {
  let runs = 0;
  const h = await fixture(t, { execute: async () => { runs += 1; } });
  const id = await h.approve();
  const evaluate = h.policy.evaluate.bind(h.policy);
  h.policy.evaluate = (request) => { const decision = evaluate(request); h.repository.revision = "changed"; return decision; };
  assert.equal((await h.executor.invoke({ ...h.request, approvalId: id })).status, "denied");
  assert.equal(runs, 0);
  assert.equal(h.store.getApproval("a", id).consumedBy, null);
});

test("persisted approval resumes after reopening with the same trusted context", async (t) => {
  let runs = 0;
  const h = await fixture(t, { execute: async () => { runs += 1; return { output: "done" }; } });
  const id = await h.approve();
  h.store.transitionTask("a", h.request.taskId, "waiting_for_approval");
  h.store.transitionTask("a", h.request.taskId, "running");
  h.reopen();
  assert.equal((await h.executor.invoke({ ...h.request, approvalId: id })).status, "succeeded");
  assert.equal((await h.executor.invoke(h.request)).replayed, true);
  const otherPrincipal = await h.executor.invoke({ ...h.request, userId: "other" });
  assert.equal(otherPrincipal.replayed, false);
  assert.equal(otherPrincipal.status, "awaiting_approval");
  assert.equal(runs, 1);
});

test("single-use consumption stays atomic across two SQLite connections", async (t) => {
  const h = await fixture(t);
  const id = await h.approve();
  const second = new PlatformTaskStore(h.filename);
  try {
    // The second connection shares the same deadline clock through a fresh
    // non-expiring approval, avoiding test wall-clock assumptions.
    const approval = h.store.createApproval({ tenantId: "a", taskId: h.request.taskId, tool: "demo.action", actionDigest: "digest", requestedBy: "owner" });
    h.store.resolveApproval("a", approval.id, { decision: "approved", resolvedBy: "owner" });
    const results = await Promise.all([Promise.resolve().then(() => h.store.consumeApproval("a", approval.id, "call-one")), Promise.resolve().then(() => second.consumeApproval("a", approval.id, "call-two"))]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(h.store.consumeApproval("a", id, "wrong", { requestedBy: "other" }), false);
  } finally { second.close(); }
});

test("executor scrubs output, object keys, evidence and errors before persistence", async (t) => {
  const secret = "a-private-value-without-vendor-prefix";
  const h = await fixture(t, { consequential: false, knownSecrets: [secret], execute: async () => ({ output: { [secret]: secret }, evidence: [{ token: secret }] }) });
  const out = await h.executor.invoke(h.request);
  assert.equal(out.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(out), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(h.store.getToolCalls("a", h.request.taskId)), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(h.store.listEvents("a")), new RegExp(secret));
  const bytes = await readFile(h.filename);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  const errorFixture = await fixture(t, { consequential: false, knownSecrets: [secret], execute: async () => { throw new Error(`Adapter leaked ${secret}`); } });
  const failed = await errorFixture.executor.invoke(errorFixture.request);
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(errorFixture.store.listEvents("a")), new RegExp(secret));
});

test("plaintext secrets are denied with safe durable input and audit events", async (t) => {
  const secret = "gsk_123456789012345678901234567890";
  const h = await fixture(t, { consequential: false });
  const refused = await h.executor.invoke({ ...h.request, input: { text: secret } });
  assert.equal(refused.result.error.code, "PLAINTEXT_CREDENTIAL");
  assert.doesNotMatch(JSON.stringify(h.store.getToolCalls("a", h.request.taskId)), new RegExp(secret));
  assert.equal((await readFile(h.filename)).includes(Buffer.from(secret)), false);
  h.executor.register({ name: "demo.credentials", description: "Reject secret-bearing input", risk: "read",
    inputSchema: { type: "object", properties: { password: { type: "string" } } }, execute: async () => "unsafe" });
  const password = await h.executor.invoke({ ...h.request, tool: "demo.credentials", input: { password: "opaque-value" } });
  assert.equal(password.result.error.code, "PLAINTEXT_CREDENTIAL");
  assert.doesNotMatch(JSON.stringify(h.store.getToolCalls("a", h.request.taskId)), /opaque-value/);
});

test("changed trusted context versions invalidate approval and idempotent replay", async (t) => {
  let runs = 0;
  const h = await fixture(t, { execute: async () => { runs += 1; return "done"; } });
  h.repository.version = 1;
  const id = await h.approve();
  h.repository.version = 2;
  assert.equal((await h.executor.invoke({ ...h.request, approvalId: id })).status, "denied");
  h.repository.version = 1;
  assert.equal((await h.executor.invoke({ ...h.request, approvalId: id })).status, "succeeded");
  h.repository.version = 2;
  const next = await h.executor.invoke(h.request);
  assert.equal(next.status, "awaiting_approval");
  assert.equal(next.replayed, false);
  assert.equal(runs, 1);
});

test("cancellation during preparation stops execution without spending approval", async (t) => {
  let runs = 0;
  const h = await fixture(t, { execute: async () => { runs += 1; } });
  const id = await h.approve();
  const evaluate = h.policy.evaluate.bind(h.policy);
  h.policy.evaluate = (request) => { const decision = evaluate(request); h.store.transitionTask("a", h.request.taskId, "cancelled"); return decision; };
  assert.equal((await h.executor.invoke({ ...h.request, approvalId: id })).status, "denied");
  assert.equal(runs, 0);
  assert.equal(h.store.getApproval("a", id).consumedBy, null);
});

test("sensitive field names redact opaque tokens and cookies while preserving references", async (t) => {
  const names = ["refresh_token", "session_token", "session_cookie", "cookie", "set-cookie", "password", "private_key", "api_key"];
  const output = Object.fromEntries(names.map((name) => [name, `opaque-${name}-value`]));
  output.credentialRef = "WORK_ACCOUNT";
  const h = await fixture(t, { consequential: false, execute: async () => ({ output }) });
  const result = await h.executor.invoke(h.request);
  assert.equal(result.status, "succeeded");
  for (const name of names) assert.equal(result.result.output[name], "[redacted:credential-field]");
  assert.equal(result.result.output.credentialRef, "WORK_ACCOUNT");
  assert.doesNotMatch(JSON.stringify(h.store.getToolCalls("a", h.request.taskId)), /opaque-/);
});

test("nested cookie collections cannot expose opaque session credentials", async t => {
  const h = await fixture(t, { consequential: false, execute: async () => ({ output: { cookies: [{ name: "session", value: "opaque-browser-session" }], credentialRef: "BROWSER_SESSION" } }) });
  const result = await h.executor.invoke(h.request);
  assert.equal(result.result.output.cookies, "[redacted:credential-field]");
  assert.equal(result.result.output.credentialRef, "BROWSER_SESSION");
  assert.equal(JSON.stringify(h.store.getToolCalls("a", h.request.taskId)).includes("opaque-browser-session"), false);
});
