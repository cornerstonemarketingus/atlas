import assert from "node:assert/strict";
import test from "node:test";

import { defineTool } from "../../../packages/atlas-contracts/src/index.mjs";
import { AuthorizedToolExecutor, PlatformTaskStore, PolicyEngine } from "../src/platform/index.mjs";
import { TaskBudget } from "../src/platform/budget.mjs";
import { taskObservability } from "../src/platform/workers/observability.mjs";
import { WorkerRegistry, WorkerRegistryError } from "../src/platform/workers/registry.mjs";

const T = "tenant-a";
const code = (c) => (e) => e instanceof WorkerRegistryError && e.code === c;

function harness() {
  let now = new Date("2026-09-01T00:00:00Z").getTime();
  const clock = () => new Date(now);
  const registry = new WorkerRegistry(":memory:", { clock, heartbeatTtlMs: 60_000, isOwner: ({ tenantId, userId }) => tenantId === T && userId === "owner" });
  return { registry, advance: (ms) => { now += ms; } };
}

const browserBox = { browser: true, terminal: ["container"], models: ["llama3"] };
const gpuBox = { desktop: true, terminal: ["process", "vm"], gpu: { vramGb: 24 }, models: ["llama3", "qwen-coder"] };

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test("registration starts untrusted; only the owner can enroll, verify and revoke", () => {
  const { registry } = harness();
  const w = registry.register({ tenantId: T, name: "laptop", kind: "local", capabilities: browserBox, registeredBy: "laptop-agent" });
  assert.equal(w.trust, "untrusted");
  assert.equal(w.availability.available, false);
  assert.throws(() => registry.approveEnrollment(T, w.id, { approver: "intruder" }), code("NOT_OWNER"));
  assert.throws(() => registry.verifyWorker(T, w.id, { verifier: "owner" }), code("ILLEGAL_TRUST_TRANSITION"));
  assert.equal(registry.approveEnrollment(T, w.id, { approver: "owner" }).trust, "enrolled");
  assert.equal(registry.verifyWorker(T, w.id, { verifier: "owner", evidence: { attestation: "tpm" } }).trust, "verified");
  assert.throws(() => registry.revoke(T, w.id, { by: "intruder" }), code("NOT_OWNER"));
  assert.equal(registry.revoke(T, w.id, { by: "owner", reason: "lost laptop" }).revoked, true);
  assert.throws(() => registry.heartbeat(T, w.id), code("WORKER_REVOKED"));
  assert.deepEqual(registry.auditTrail(T, w.id).map((a) => a.action), ["registered", "enrolled", "verified", "revoked"]);
  assert.equal(registry.getWorker("tenant-b", w.id), null, "tenant isolation");
  assert.throws(() => new WorkerRegistry(":memory:", {}), /isOwner/u);
});

test("scheduling matches capabilities and minimum trust for the task risk", () => {
  const { registry } = harness();
  const browser = registry.register({ tenantId: T, name: "cloud-browser", kind: "cloud", capabilities: browserBox });
  const gpu = registry.register({ tenantId: T, name: "workstation", kind: "local", capabilities: gpuBox });
  const untrusted = registry.register({ tenantId: T, name: "stranger", kind: "cloud", capabilities: { ...browserBox, ...gpuBox, browser: true } });
  registry.approveEnrollment(T, browser.id, { approver: "owner" });
  registry.approveEnrollment(T, gpu.id, { approver: "owner" });
  registry.verifyWorker(T, gpu.id, { verifier: "owner" });
  for (const w of [browser, gpu, untrusted]) registry.heartbeat(T, w.id, { load: 0.2 });

  const b = registry.schedule({ tenantId: T, requirements: { browser: true, terminal: "container" }, risk: "moderate" });
  assert.equal(b.worker.id, browser.id);
  assert.ok(b.rejected.find((r) => r.id === untrusted.id).reasons.some((r) => /untrusted/u.test(r)));

  const g = registry.schedule({ tenantId: T, requirements: { gpu: { minVramGb: 16 }, models: ["qwen-coder"], terminal: "container" }, risk: "high" });
  assert.equal(g.worker.id, gpu.id, "vm isolation satisfies a container requirement");

  const high = registry.schedule({ tenantId: T, requirements: { browser: true }, risk: "critical" });
  assert.equal(high.worker, null, "enrolled is not enough for critical risk");
  assert.match(high.rejected.find((r) => r.id === browser.id).reasons[0], /below 'verified'/u);

  const local = registry.schedule({ tenantId: T, requirements: { browser: true, local: true }, risk: "low" });
  assert.equal(local.worker, null);
  const tooBig = registry.schedule({ tenantId: T, requirements: { gpu: { minVramGb: 48 } }, risk: "low" });
  assert.match(tooBig.rejected.find((r) => r.id === gpu.id).reasons[0], /24 GB < 48 GB/u);
});

test("stale heartbeats make a worker unavailable; load and revocation affect scheduling", () => {
  const { registry, advance } = harness();
  const a = registry.register({ tenantId: T, name: "a", kind: "cloud", capabilities: browserBox });
  const c = registry.register({ tenantId: T, name: "c", kind: "cloud", capabilities: browserBox });
  for (const w of [a, c]) registry.approveEnrollment(T, w.id, { approver: "owner" });
  registry.heartbeat(T, a.id, { load: 0.9 });
  registry.heartbeat(T, c.id, { load: 0.1 });
  assert.equal(registry.schedule({ tenantId: T, requirements: { browser: true }, risk: "low" }).worker.id, c.id, "least loaded first");
  advance(45_000);
  registry.heartbeat(T, a.id, { load: 0.9 });
  advance(20_000); // c is now 65 s stale, a 20 s
  assert.match(registry.getWorker(T, c.id).availability.reason, /stale/u);
  assert.equal(registry.schedule({ tenantId: T, requirements: { browser: true }, risk: "low" }).worker.id, a.id);
  registry.revoke(T, a.id, { by: "owner" });
  const none = registry.schedule({ tenantId: T, requirements: { browser: true }, risk: "low" });
  assert.equal(none.worker, null);
  assert.ok(none.rejected.find((r) => r.id === a.id).reasons.includes("unavailable: revoked"));
});

test("heartbeats may shrink but never grow capabilities", () => {
  const { registry } = harness();
  const w = registry.register({ tenantId: T, name: "w", kind: "local", capabilities: gpuBox });
  registry.approveEnrollment(T, w.id, { approver: "owner" });
  assert.throws(() => registry.heartbeat(T, w.id, { capabilities: { ...gpuBox, browser: true } }), code("CAPABILITY_GROWTH"));
  assert.throws(() => registry.heartbeat(T, w.id, { capabilities: { ...gpuBox, gpu: { vramGb: 80 } } }), code("CAPABILITY_GROWTH"));
  const shrunk = registry.heartbeat(T, w.id, { capabilities: { ...gpuBox, gpu: null } });
  assert.equal(shrunk.capabilities.gpu, null);
  assert.throws(() => registry.register({ tenantId: T, name: "x", kind: "cloud", capabilities: { terminal: "root" } }), code("INVALID_CAPABILITIES"));
});

// ---------------------------------------------------------------------------
// observability
// ---------------------------------------------------------------------------

test("observability rollup: tool calls, models, cost matching budget charges, memory, failures, artifacts", async () => {
  const store = new PlatformTaskStore(":memory:");
  const executor = new AuthorizedToolExecutor({ store, policy: new PolicyEngine({ version: "obs.1", rules: [] }) });
  executor.register(defineTool({
    name: "model.complete", description: "Call a model.", risk: "read",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ output: { model: "local-small", text: "hi" }, usage: { inputTokens: 100, outputTokens: 20, costMicroUsd: 300 } }),
  }));
  executor.register(defineTool({
    name: "memory.read", description: "Read a memory entry.", risk: "read",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    execute: async ({ id }) => ({ output: { id, content: "remembered" } }),
  }));
  executor.register(defineTool({
    name: "web.fetch", description: "Fetch a page.", risk: "read",
    inputSchema: { type: "object", properties: {} },
    execute: async () => { throw Object.assign(new Error("timeout"), { code: "TIMEOUT" }); },
  }));
  const task = store.createTask({ tenantId: T, userId: "owner", agentId: "agent-1", objective: "Observe me.", successCriteria: ["done"], budget: { toolCalls: 10, costMicroUsd: 1_000 } });
  for (const to of ["authorized", "queued", "running"]) store.transitionTask(T, task.id, to, { reason: to, actor: "owner" });
  const actor = { tenantId: T, userId: "owner", agentId: "agent-1", taskId: task.id, grantedPermissions: ["model.*", "memory.*", "web.*"] };
  await executor.invoke({ ...actor, tool: "model.complete", input: {} });
  await executor.invoke({ ...actor, tool: "memory.read", input: { id: "mem_1" } });
  await executor.invoke({ ...actor, tool: "web.fetch", input: {} });
  // A model charge attributed by name, as a model adapter would record it.
  const budget = new TaskBudget({ store, tenantId: T, taskId: task.id });
  budget.charge({ costMicroUsd: 250, inputTokens: 50 });
  store.appendEvent({ type: "agent.message", tenantId: T, correlationId: task.correlationId, taskId: task.id, payload: { model: "cloud-big", memoryRefs: ["mem_2"] } });
  budget.charge({ costMicroUsd: 600 }); // pushes past the 1,000 µUSD limit
  const good = store.submitArtifact({ tenantId: T, taskId: task.id, kind: "summary", content: { ok: true } });
  store.markArtifactVerified(T, good.id, { verified: true, evidence: [{ check: "ok" }] });
  const bad = store.submitArtifact({ tenantId: T, taskId: task.id, kind: "summary", content: { ok: false } });
  store.markArtifactVerified(T, bad.id, { verified: false, evidence: [{ check: "failed" }] });
  const other = store.createTask({ tenantId: "tenant-b", userId: "u", objective: "other", successCriteria: ["x"], budget: {} });

  const eventsBefore = store.listEvents(T).length;
  const view = taskObservability(store, T, task.id);
  assert.equal(store.listEvents(T).length, eventsBefore, "the rollup is read-only");

  assert.equal(view.toolCalls.total, 3);
  assert.deepEqual(view.toolCalls.byStatus, { succeeded: 2, failed: 1 });
  assert.equal(view.toolCalls.byTool["web.fetch"].failed, 1);

  const charged = store.listEvents(T, { taskId: task.id }).filter((e) => e.type === "budget.charged")
    .reduce((sum, e) => sum + (e.payload.amounts.costMicroUsd ?? 0), 0);
  assert.equal(charged, 300 + 250 + 600);
  assert.equal(view.cost.totalMicroUsd, charged);
  assert.equal(view.cost.consistent, true);
  assert.equal(view.cost.recordedUsageMicroUsd, charged);
  assert.equal(view.tokens.inputTokens, 150);

  assert.deepEqual(view.models.map((m) => m.model).sort(), ["cloud-big", "local-small"]);
  assert.deepEqual(view.memoryReferences.map((m) => m.ref).sort(), ["mem_1", "mem_2"]);
  const kinds = view.failures.map((f) => f.kind);
  assert.ok(kinds.includes("tool_call.failed"));
  assert.ok(kinds.includes("budget.exceeded"));
  assert.ok(kinds.includes("artifact.rejected"));
  assert.deepEqual(view.artifacts.map((a) => a.verification).sort(), ["rejected", "verified"]);

  assert.throws(() => taskObservability(store, T, other.id), /No such task/u);
  store.close();
});

test("observability pages through more events than one listEvents page", () => {
  const store = new PlatformTaskStore(":memory:");
  const task = store.createTask({ tenantId: T, userId: "owner", objective: "Many charges.", successCriteria: ["done"], budget: {} });
  const budget = new TaskBudget({ store, tenantId: T, taskId: task.id });
  for (let i = 0; i < 520; i += 1) budget.charge({ costMicroUsd: 1 });
  const view = taskObservability(store, T, task.id);
  assert.equal(view.cost.chargedEvents, 520);
  assert.equal(view.cost.totalMicroUsd, 520);
  assert.equal(view.cost.consistent, true);
  store.close();
});
