import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  artifactSchema,
  defineTool,
  eventSchema,
  executionResultSchema,
  newCorrelationId,
  policyDecisionSchema,
  taskSchema,
  toolCallSchema,
  validateSchema,
} from "../../../packages/atlas-contracts/src/index.mjs";
import {
  AuthorizedToolExecutor,
  PlatformTaskStore,
  PolicyEngine,
  TaskBudget,
  TaskBudgetExceededError,
  matchesPermission,
  repositoryPlatformTools,
  verifyArtifact,
} from "../src/platform/index.mjs";

const A = "tenant-a";
const B = "tenant-b";

async function harness(t, { policy = { version: "test.1", rules: [] }, clock } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-platform-"));
  const filename = join(directory, "platform.sqlite");
  let store = new PlatformTaskStore(filename, clock ? { clock } : {});
  const engine = new PolicyEngine(policy);
  const executor = new AuthorizedToolExecutor({ store, policy: engine });
  t.after(async () => {
    try { store.close(); } catch { /* already closed by a reopen test */ }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    filename,
    get store() { return store; },
    reopen() { store.close(); store = new PlatformTaskStore(filename); return store; },
    engine,
    executor,
  };
}

function newTask(store, overrides = {}) {
  return store.createTask({
    tenantId: A, userId: "user-1", agentId: "agent-1", objective: "Summarize the repository.",
    successCriteria: ["A summary artifact exists."], budget: { toolCalls: 10 }, ...overrides,
  });
}

function runningTask(store, overrides = {}) {
  const task = newTask(store, overrides);
  for (const to of ["authorized", "queued", "running"]) store.transitionTask(task.tenantId, task.id, to, { actor: "test" });
  return store.getTask(task.tenantId, task.id);
}

function echoTool(overrides = {}, onRun = () => {}) {
  return defineTool({
    name: "demo.echo",
    description: "Echo the text back.",
    risk: "read",
    inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 100 } } },
    async execute(input) { onRun(input); return { output: { echoed: input.text }, evidence: [{ kind: "echo" }] }; },
    ...overrides,
  });
}

const valid = (schema, value) => assert.deepEqual(validateSchema(schema, value), []);

// ---------------------------------------------------------------------------
// Task lifecycle and tenancy
// ---------------------------------------------------------------------------

test("task lifecycle: legal transitions are persisted, illegal ones refused", async (t) => {
  const h = await harness(t);
  const task = newTask(h.store);
  valid(taskSchema, task);
  assert.equal(task.status, "proposed");
  assert.throws(() => h.store.transitionTask(A, task.id, "completed"), { code: "ILLEGAL_TRANSITION" });
  for (const to of ["authorized", "queued", "running", "verifying", "completed"]) {
    h.store.transitionTask(A, task.id, to, { reason: `to ${to}`, actor: "controller" });
  }
  assert.throws(() => h.store.transitionTask(A, task.id, "running"), { code: "ILLEGAL_TRANSITION" });
  const reopened = h.reopen();
  const persisted = reopened.getTask(A, task.id);
  assert.equal(persisted.status, "completed");
  const transitions = reopened.listTransitions(A, task.id);
  assert.deepEqual(transitions.map((row) => `${row.from}->${row.to}`), [
    "proposed->authorized", "authorized->queued", "queued->running", "running->verifying", "verifying->completed",
  ]);
  assert.equal(transitions[0].actor, "controller");
});

test("transitions use optimistic concurrency", async (t) => {
  const h = await harness(t);
  const task = newTask(h.store);
  const version = h.store.getTaskVersion(A, task.id);
  h.store.transitionTask(A, task.id, "authorized", { expectedVersion: version });
  assert.throws(() => h.store.transitionTask(A, task.id, "queued", { expectedVersion: version }), { code: "CONCURRENT_MODIFICATION" });
  assert.throws(() => h.store.transitionTask(A, task.id, "queued", { expectedStatus: "proposed" }), { code: "CONCURRENT_MODIFICATION" });
  assert.equal(h.store.transitionTask(A, task.id, "queued", { expectedStatus: "authorized" }).status, "queued");
});

test("tenant B cannot read or act on tenant A's records through any read path", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store);
  h.executor.register(echoTool());
  const call = await h.executor.invoke({ tenantId: A, userId: "user-1", taskId: task.id, tool: "demo.echo", input: { text: "hi" }, grantedPermissions: ["demo.*"] });
  const artifact = h.store.submitArtifact({ tenantId: A, taskId: task.id, kind: "summary", content: { text: "x" } });
  const approval = h.store.createApproval({ tenantId: A, taskId: task.id, tool: "demo.echo", actionDigest: "sha256:x" });

  assert.equal(h.store.getTask(B, task.id), null);
  assert.deepEqual(h.store.listTasks(B), []);
  assert.equal(h.store.getTaskVersion(B, task.id), null);
  assert.deepEqual(h.store.listTransitions(B, task.id), []);
  assert.deepEqual(h.store.getToolCalls(B, task.id), []);
  assert.equal(h.store.getToolCall(B, call.toolCallId), null);
  assert.equal(h.store.getPolicyDecision(B, call.decision.id), null);
  assert.equal(h.store.getArtifact(B, artifact.id), null);
  assert.deepEqual(h.store.listArtifacts(B, { taskId: task.id }), []);
  assert.equal(h.store.getApproval(B, approval.id), null);
  assert.deepEqual(h.store.listApprovals(B), []);
  assert.deepEqual(h.store.listEvents(B), []);
  assert.deepEqual(h.store.listEvents(B, { taskId: task.id }), []);
  assert.equal(h.store.getIdempotency(B, h.store.getToolCall(A, call.toolCallId).idempotencyKey), null);
  assert.throws(() => h.store.getTask(undefined, task.id), { code: "TENANT_REQUIRED" });

  // Writes are tenant-scoped too.
  assert.throws(() => h.store.transitionTask(B, task.id, "failed"), { code: "NOT_FOUND" });
  assert.throws(() => h.store.submitArtifact({ tenantId: B, taskId: task.id, kind: "x", content: 1 }), { code: "NOT_FOUND" });
  assert.throws(() => h.store.resolveApproval(B, approval.id, { decision: "approved", resolvedBy: "mallory" }), { code: "NOT_FOUND" });
  await assert.rejects(
    h.executor.invoke({ tenantId: B, userId: "u", taskId: task.id, tool: "demo.echo", input: { text: "hi" }, grantedPermissions: ["demo.*"] }),
    { code: "NOT_FOUND" },
  );
  assert.equal(h.store.getTask(A, task.id).status, "running");
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const readTool = defineTool({ name: "browser.navigate", description: "Navigate.", risk: "low", inputSchema: { type: "object" }, async execute() { return {}; } });
const submitTool = defineTool({ name: "browser.submit_form", description: "Submit.", risk: "moderate", consequential: true, inputSchema: { type: "object" }, async execute() { return {}; } });
const criticalTool = defineTool({ name: "terminal.run_command", description: "Run.", risk: "critical", inputSchema: { type: "object" }, async execute() { return {}; } });
const base = { tenantId: A, userId: "user-1", agentId: "agent-1", taskId: "tsk_x" };

test("policy: default deny, glob grants on dotted segments", () => {
  const engine = new PolicyEngine({ version: "p.1", rules: [] });
  const denied = engine.evaluate({ ...base, tool: readTool, input: {}, grantedPermissions: [] });
  valid(policyDecisionSchema, denied);
  assert.equal(denied.effect, "deny");
  assert.match(denied.reasons[0], /default deny/);
  assert.equal(engine.evaluate({ ...base, tool: readTool, input: {}, grantedPermissions: ["browser.*"] }).effect, "allow");
  assert.equal(engine.evaluate({ ...base, tool: readTool, input: {}, grantedPermissions: ["terminal.*"] }).effect, "deny");
  assert.equal(engine.evaluate({ ...base, tool: readTool, input: {}, grantedPermissions: ["*"] }).effect, "deny");
  assert.equal(matchesPermission("browser.*", "browser.tab.open"), false);
  assert.equal(matchesPermission("browser.**", "browser.tab.open"), true);
  assert.equal(matchesPermission("*.navigate", "browser.navigate"), true);
});

test("policy: explicit deny beats any grant, and decisions are deterministic", () => {
  const engine = new PolicyEngine({ version: "p.2", rules: [
    { id: "no-terminal-for-agent-9", effect: "deny", tools: ["terminal.**"], agents: ["agent-9"], reason: "sandboxed agent" },
    { id: "allow-browser", effect: "allow", tools: ["browser.*"] },
  ] });
  const request = { ...base, agentId: "agent-9", tool: criticalTool, input: {}, grantedPermissions: ["terminal.run_command"] };
  const first = engine.decide(request);
  assert.equal(first.effect, "deny");
  assert.match(first.reasons[0], /no-terminal-for-agent-9/);
  assert.deepEqual(engine.decide(request), first);
  // An allow rule never substitutes for a granted permission.
  assert.equal(engine.decide({ ...base, tool: readTool, input: {}, grantedPermissions: [] }).effect, "deny");
});

test("policy: consequential and critical tools require approval; a role label grants nothing", () => {
  const engine = new PolicyEngine({ version: "p.3", rules: [] });
  assert.equal(engine.decide({ ...base, tool: submitTool, input: {}, grantedPermissions: ["browser.*"] }).effect, "require_approval");
  assert.equal(engine.decide({ ...base, tool: criticalTool, input: {}, grantedPermissions: ["terminal.*"] }).effect, "require_approval");
  assert.equal(engine.decide({ ...base, tool: submitTool, input: {}, grantedPermissions: ["browser.*"], approval: { id: "apr_1", verified: true } }).effect, "allow");
  assert.equal(engine.decide({ ...base, tool: submitTool, input: {}, grantedPermissions: ["browser.*"], approval: { id: "apr_1" } }).effect, "require_approval");
  const admin = engine.decide({ ...base, tool: readTool, input: {}, grantedPermissions: ["role:admin"], role: "admin", agent: { role: "admin" } });
  assert.equal(admin.effect, "deny");
});

test("policy: argument constraints deny URLs outside the allowed origins", () => {
  const engine = new PolicyEngine({ version: "p.4", rules: [{ id: "origins", tool: "browser.navigate", allowOrigins: ["https://example.com"] }] });
  const request = (url) => ({ ...base, tool: readTool, input: { url }, grantedPermissions: ["browser.*"] });
  assert.equal(engine.decide(request("https://example.com/docs?q=1")).effect, "allow");
  assert.equal(engine.decide(request("https://example.com.evil.test/")).effect, "deny");
  assert.equal(engine.decide(request("javascript:alert(1)")).effect, "deny");
  assert.equal(engine.decide(request(undefined)).effect, "deny");
});

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

test("executor: successful call is audited, and an identical retry replays without re-executing", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store);
  let runs = 0;
  h.executor.register(echoTool({}, () => { runs += 1; }));
  const request = { tenantId: A, userId: "user-1", agentId: "agent-1", taskId: task.id, tool: "demo.echo", input: { text: "hello" }, grantedPermissions: ["demo.echo"] };
  const first = await h.executor.invoke(request);
  assert.equal(first.status, "succeeded");
  valid(executionResultSchema, first.result);
  assert.deepEqual(first.result.output, { echoed: "hello" });
  const second = await h.executor.invoke({ ...request, input: { text: "hello" } });
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(runs, 1);
  const calls = h.store.getToolCalls(A, task.id);
  assert.equal(calls.length, 1);
  calls.forEach((call) => valid(toolCallSchema, call));
  assert.equal(calls[0].status, "succeeded");
  assert.equal(h.store.getTask(A, task.id).usage.toolCalls, 1);
});

test("executor: invalid input is refused before policy or budget", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store);
  h.executor.register(echoTool());
  const out = await h.executor.invoke({ tenantId: A, userId: "u", taskId: task.id, tool: "demo.echo", input: { text: 5 }, grantedPermissions: ["demo.*"] });
  assert.equal(out.status, "failed");
  assert.equal(out.result.error.code, "INVALID_INPUT");
  assert.equal(h.store.getTask(A, task.id).usage.toolCalls, 0);
  assert.equal(h.store.getToolCall(A, out.toolCallId).policyDecisionId, null);
});

test("executor: denies without a grant and requires a running task", async (t) => {
  const h = await harness(t);
  h.executor.register(echoTool());
  const idle = newTask(h.store);
  await assert.rejects(h.executor.invoke({ tenantId: A, userId: "u", taskId: idle.id, tool: "demo.echo", input: { text: "a" }, grantedPermissions: ["demo.*"] }), { code: "TASK_NOT_RUNNING" });
  const task = runningTask(h.store);
  const out = await h.executor.invoke({ tenantId: A, userId: "u", agentId: "agent-1", taskId: task.id, tool: "demo.echo", input: { text: "a" }, grantedPermissions: [] });
  assert.equal(out.status, "denied");
  assert.equal(out.result.error.code, "POLICY_DENIED");
  const call = h.store.getToolCall(A, out.toolCallId);
  assert.equal(call.status, "denied");
  assert.equal(h.store.getPolicyDecision(A, call.policyDecisionId).effect, "deny");
  assert.ok(h.store.listEvents(A, { taskId: task.id }).some((e) => e.type === "tool_call.decided" && e.payload.effect === "deny"));
});

test("executor: consequential tool needs an approval bound to the exact action", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store);
  let submitted = [];
  h.executor.register(defineTool({
    name: "demo.send_email", description: "Send an email.", risk: "moderate", consequential: true,
    inputSchema: { type: "object", additionalProperties: false, required: ["to"], properties: { to: { type: "string" } } },
    async execute(input) { submitted.push(input.to); return { output: { sent: true } }; },
  }));
  const request = { tenantId: A, userId: "user-1", taskId: task.id, tool: "demo.send_email", input: { to: "a@example.com" }, grantedPermissions: ["demo.*"] };

  const asked = await h.executor.invoke(request);
  assert.equal(asked.status, "awaiting_approval");
  assert.ok(asked.approvalId);
  assert.equal(h.store.getToolCall(A, asked.toolCallId).status, "awaiting_approval");

  // Pending approval is not enough.
  const early = await h.executor.invoke({ ...request, approvalId: asked.approvalId });
  assert.equal(early.status, "denied");
  assert.match(early.result.error.message, /pending/);

  h.store.resolveApproval(A, asked.approvalId, { decision: "approved", resolvedBy: "user-1" });
  assert.throws(() => h.store.resolveApproval(A, asked.approvalId, { decision: "rejected", resolvedBy: "user-2" }), { code: "ALREADY_RESOLVED" });
  assert.equal(h.store.getApproval(A, asked.approvalId).resolvedBy, "user-1");

  // Approved for a@, not b@.
  const swapped = await h.executor.invoke({ ...request, input: { to: "b@example.com" }, approvalId: asked.approvalId });
  assert.equal(swapped.status, "denied");
  assert.match(swapped.result.error.message, /different action/);

  const done = await h.executor.invoke({ ...request, approvalId: asked.approvalId });
  assert.equal(done.status, "succeeded");
  assert.equal(done.toolCallId, asked.toolCallId, "the approved call resumes the original tool call");
  assert.deepEqual(submitted, ["a@example.com"]);
  assert.match(done.decision.reasons.at(-1), /approval/);

  // Replay returns the stored result; the approval cannot be spent twice.
  const again = await h.executor.invoke({ ...request, approvalId: asked.approvalId });
  assert.equal(again.replayed, true);
  assert.deepEqual(submitted, ["a@example.com"]);
  assert.equal(h.store.getApproval(A, asked.approvalId).consumedBy, asked.toolCallId);
});

test("executor: rejected approval denies the action", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store);
  h.executor.register(echoTool({ name: "demo.delete", consequential: true }));
  const request = { tenantId: A, userId: "u", taskId: task.id, tool: "demo.delete", input: { text: "rec" }, grantedPermissions: ["demo.*"] };
  const asked = await h.executor.invoke(request);
  h.store.resolveApproval(A, asked.approvalId, { decision: "rejected", resolvedBy: "owner", reason: "no" });
  const out = await h.executor.invoke({ ...request, approvalId: asked.approvalId });
  assert.equal(out.status, "denied");
});

test("budget: the 4th call of a 3-call budget is refused, and usage survives reopening", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store, { budget: { toolCalls: 3 } });
  let runs = 0;
  h.executor.register(echoTool({}, () => { runs += 1; }));
  const call = (text) => h.executor.invoke({ tenantId: A, userId: "u", taskId: task.id, tool: "demo.echo", input: { text }, grantedPermissions: ["demo.*"] });
  for (const text of ["1", "2", "3"]) assert.equal((await call(text)).status, "succeeded");
  const fourth = await call("4");
  assert.equal(fourth.status, "failed");
  assert.equal(fourth.result.error.code, "BUDGET_EXCEEDED");
  assert.equal(runs, 3);
  assert.ok(h.store.listEvents(A, { taskId: task.id }).some((e) => e.type === "budget.exceeded"));

  const reopened = h.reopen();
  assert.equal(reopened.getTask(A, task.id).usage.toolCalls, 3);
  assert.ok(reopened.getTask(A, task.id).usage.wallTimeMs >= 0);
  const budget = new TaskBudget({ store: reopened, tenantId: A, taskId: task.id });
  assert.throws(() => budget.reserve(), TaskBudgetExceededError);
  assert.equal(reopened.getTask(A, task.id).usage.toolCalls, 3, "a refused reservation records nothing");
});

test("budget: tool-reported token usage is charged to the task", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store, { budget: { toolCalls: 5, inputTokens: 100 } });
  h.executor.register(echoTool({ async execute() { return { output: "ok", usage: { inputTokens: 60, outputTokens: 5 } }; } }));
  const call = (text) => h.executor.invoke({ tenantId: A, userId: "u", taskId: task.id, tool: "demo.echo", input: { text }, grantedPermissions: ["demo.*"] });
  assert.equal((await call("a")).result.usage.inputTokens, 60);
  assert.equal((await call("b")).status, "succeeded");
  assert.equal(h.store.getTask(A, task.id).usage.inputTokens, 120);
  const third = await call("c");
  assert.equal(third.result.error.code, "BUDGET_EXCEEDED", "an overspent dimension blocks the next reservation");
});

test("executor: a timeout produces a failed, retryable tool call with no stack trace", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store);
  h.executor.register(echoTool({
    name: "demo.slow",
    async execute(_input, { signal }) {
      await new Promise((resolve) => { const timer = setTimeout(resolve, 2_000); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }); });
      return { output: "late" };
    },
  }), { timeoutMs: 30 });
  h.executor.register(echoTool({ name: "demo.broken", async execute() { throw new Error("boom\n    at secret (/home/x/file.mjs:1:1)"); } }));
  const slow = await h.executor.invoke({ tenantId: A, userId: "u", taskId: task.id, tool: "demo.slow", input: { text: "x" }, grantedPermissions: ["demo.*"] });
  assert.equal(slow.status, "failed");
  assert.deepEqual({ code: slow.result.error.code, retryable: slow.result.error.retryable }, { code: "TIMEOUT", retryable: true });
  assert.equal(h.store.getToolCall(A, slow.toolCallId).status, "failed");
  const broken = await h.executor.invoke({ tenantId: A, userId: "u", taskId: task.id, tool: "demo.broken", input: { text: "x" }, grantedPermissions: ["demo.*"] });
  assert.deepEqual(broken.result.error, { code: "TOOL_ERROR", message: "boom", retryable: false });
  // A failed call releases its idempotency key so a genuine retry runs again.
  assert.equal(h.store.getIdempotency(A, h.store.getToolCall(A, slow.toolCallId).idempotencyKey), null);
});

test("every event for a task shares its correlation id", async (t) => {
  const h = await harness(t);
  const correlationId = newCorrelationId();
  const task = runningTask(h.store, { correlationId });
  assert.equal(task.correlationId, correlationId);
  assert.notEqual(newTask(h.store, { correlationId: "evil\nlog-injection" }).correlationId, "evil\nlog-injection");
  h.executor.register(echoTool());
  await h.executor.invoke({ tenantId: A, userId: "u", taskId: task.id, tool: "demo.echo", input: { text: "x" }, grantedPermissions: ["demo.*"] });
  h.store.submitArtifact({ tenantId: A, taskId: task.id, kind: "note", content: "x" });
  const events = h.store.listEvents(A, { taskId: task.id });
  const types = new Set(events.map((e) => e.type));
  for (const type of ["task.created", "task.transitioned", "tool_call.requested", "tool_call.decided", "tool_call.completed", "budget.charged", "artifact.submitted"]) {
    assert.ok(types.has(type), `missing ${type}`);
  }
  for (const event of events) {
    assert.equal(event.correlationId, correlationId);
    const { seq, ...record } = event;
    valid(eventSchema, record);
  }
  assert.deepEqual(h.store.listEvents(A, { correlationId }).map((e) => e.id), events.map((e) => e.id));
  const tail = h.store.listEvents(A, { taskId: task.id, afterSeq: events[2].seq });
  assert.equal(tail.length, events.length - 3);
});

test("events are append-only", async (t) => {
  const h = await harness(t);
  newTask(h.store);
  const { DatabaseSync } = await import("node:sqlite");
  h.store.close();
  const raw = new DatabaseSync(h.filename);
  assert.throws(() => raw.exec("UPDATE events SET type = 'task.created'"), /append-only/);
  assert.throws(() => raw.exec("DELETE FROM events"), /append-only/);
  raw.close();
});

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

test("outbox: claim, ack, lease expiry and dead-letter after N attempts", async (t) => {
  let now = Date.parse("2026-09-24T00:00:00.000Z");
  const directory = await mkdtemp(join(tmpdir(), "atlas-outbox-"));
  const store = new PlatformTaskStore(join(directory, "o.sqlite"), { clock: () => new Date(now), maxOutboxAttempts: 2 });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  newTask(store);
  newTask(store);
  const pending = store.listOutbox({ status: "pending" });
  assert.equal(pending.length, 2, "each task.created event is in the outbox");

  const first = store.claimOutbox(1, "worker-1", 1_000);
  assert.equal(first.length, 1);
  assert.equal(first[0].event.type, "task.created");
  assert.equal(store.claimOutbox(10, "worker-2", 1_000).length, 1, "a leased row is not handed to a second worker");
  assert.equal(store.ackOutbox([first[0].id], "worker-2"), 0, "only the lease holder may ack");
  assert.equal(store.ackOutbox([first[0].id], "worker-1"), 1);

  const second = store.listOutbox({ status: "claimed" });
  assert.equal(second.length, 1);
  assert.deepEqual(store.nackOutbox([second[0].id], { error: "bus down" }), { retried: 1, deadLettered: 0 });
  const retry = store.claimOutbox(10, "worker-3", 1_000);
  assert.equal(retry[0].attempts, 2);
  assert.deepEqual(store.nackOutbox([retry[0].id], { error: "bus down again" }), { retried: 0, deadLettered: 1 });
  assert.equal(store.listOutbox({ status: "dead" }).length, 1);
  assert.equal(store.claimOutbox(10, "worker-3", 1_000).length, 0);

  // A crashed worker's lease expires and the row is redelivered.
  newTask(store);
  const leased = store.claimOutbox(10, "crasher", 500);
  assert.equal(leased.length, 1);
  now += 1_000;
  const redelivered = store.claimOutbox(10, "rescuer", 500);
  assert.equal(redelivered[0].id, leased[0].id);
  now += 1_000;
  assert.equal(store.claimOutbox(10, "rescuer", 500).length, 0, "expired final attempt is dead-lettered");
  assert.equal(store.listOutbox({ status: "dead" }).length, 2);
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

test("artifact verification is deterministic and never accepts prose", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store);
  const submit = (content) => h.store.submitArtifact({ tenantId: A, taskId: task.id, kind: "report", content });
  const good = submit({ rows: 3 });
  valid(artifactSchema, good);
  assert.match(good.contentDigest, /^sha256:[0-9a-f]{64}$/);

  const verified = await verifyArtifact(h.store, { tenantId: A, artifactId: good.id, check: (a) => ({ ok: a.content.rows === 3, evidence: [{ check: "row_count", expected: 3, actual: a.content.rows }] }) });
  assert.equal(verified.verification, "verified");
  assert.equal(verified.verificationEvidence.length, 2);
  await assert.rejects(verifyArtifact(h.store, { tenantId: A, artifactId: good.id, check: () => ({ ok: true, evidence: [{}] }) }), { code: "ALREADY_VERIFIED" });

  const noEvidence = await verifyArtifact(h.store, { tenantId: A, artifactId: submit(1).id, check: () => ({ ok: true, evidence: [] }) });
  assert.equal(noEvidence.verification, "rejected");
  const prose = await verifyArtifact(h.store, { tenantId: A, artifactId: submit(2).id, check: () => ({ ok: true, evidence: ["Looks correct to me."] }) });
  assert.equal(prose.verification, "rejected");
  const failing = await verifyArtifact(h.store, { tenantId: A, artifactId: submit(3).id, check: () => ({ ok: false, evidence: [{ check: "x", ok: false }] }) });
  assert.equal(failing.verification, "rejected");
  const throwing = await verifyArtifact(h.store, { tenantId: A, artifactId: submit(4).id, check: () => { throw new Error("nope"); } });
  assert.equal(throwing.verification, "rejected");
  assert.throws(() => h.store.markArtifactVerified(A, submit(5).id, { verified: true, evidence: [] }), { code: "EVIDENCE_REQUIRED" });
  assert.equal(h.store.listArtifacts(A, { taskId: task.id }).filter((a) => a.verification === "verified").length, 1);
});

// ---------------------------------------------------------------------------
// Adapter for an existing tool
// ---------------------------------------------------------------------------

test("artifact verification evidence and error codes cannot persist credentials", async (t) => {
  const h = await harness(t);
  const task = runningTask(h.store);
  const secret = "KNOWN_VAULT_CREDENTIAL_VALUE";
  const submit = () => h.store.submitArtifact({ tenantId: A, taskId: task.id, kind: "report", content: { rows: 3 } });
  const artifact = submit();
  const result = await verifyArtifact(h.store, { tenantId: A, artifactId: artifact.id, knownSecrets: [secret], check: () => ({ ok: true,
    evidence: [{ check: "rows", output: secret, authorization: "opaque-bearer", credentialRef: "CONNECTION_TOKEN" }] }) });
  assert.equal(result.verification, "verified");
  const persisted = h.store.getArtifact(A, artifact.id);
  assert.equal(JSON.stringify(persisted.verificationEvidence).includes(secret), false);
  assert.equal(JSON.stringify(persisted.verificationEvidence).includes("opaque-bearer"), false);
  assert.equal(persisted.verificationEvidence[1].credentialRef, "CONNECTION_TOKEN");
  const rejected = await verifyArtifact(h.store, { tenantId: A, artifactId: submit().id, knownSecrets: [secret], check: () => {
    const error = new Error(`Failed ${secret}`); error.code = secret; throw error;
  } });
  assert.equal(rejected.verification, "rejected");
  assert.equal(JSON.stringify(rejected.verificationEvidence).includes(secret), false);
  assert.equal(rejected.verificationEvidence[0].error.code, "TOOL_ERROR");
});

test("the existing repository.read tool runs through the authorized executor", async (t) => {
  const h = await harness(t);
  const repository = join(h.directory, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repository));
  await writeFile(join(repository, "README.md"), "line one\nline two\n");
  for (const { tool, timeoutMs } of repositoryPlatformTools({ repository })) h.executor.register(tool, { timeoutMs });
  assert.deepEqual(h.executor.list().map((tool) => tool.name).sort(), ["repository.list", "repository.read", "repository.search"]);
  const task = runningTask(h.store);
  const request = { tenantId: A, userId: "u", taskId: task.id, tool: "repository.read", grantedPermissions: ["repository.*"] };

  const read = await h.executor.invoke({ ...request, input: { path: "README.md", lineCount: 1 } });
  assert.equal(read.status, "succeeded");
  assert.equal(read.result.output, "1\tline one");

  const escape = await h.executor.invoke({ ...request, input: { path: "../../etc/passwd" } });
  assert.equal(escape.status, "failed");
  assert.equal(escape.result.error.code, "PATH_ESCAPES_REPOSITORY");

  const unknownArg = await h.executor.invoke({ ...request, input: { path: "README.md", mode: "w" } });
  assert.equal(unknownArg.result.error.code, "INVALID_INPUT");

  const ungranted = await h.executor.invoke({ ...request, input: { path: "README.md" }, grantedPermissions: ["browser.*"] });
  assert.equal(ungranted.status, "denied");
});
