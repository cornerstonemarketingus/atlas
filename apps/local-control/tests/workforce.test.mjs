import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformTaskStore } from "../src/platform/task-store.mjs";
import { createWorkforceRuntime, createWorkforceRoutes } from "../src/platform/workforce-runtime.mjs";

function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-workforce-"));
  writeFileSync(join(directory, "example.txt"), "verified repository evidence");
  let store; let runtime;
  const open = () => {
    store = new PlatformTaskStore(join(directory, "platform.sqlite"));
    runtime = createWorkforceRuntime({ store, dataDirectory: directory, repository: directory, model: "test-model", endpoint: "http://127.0.0.1:11434/v1", ...options });
  };
  open();
  t.after(() => { runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get runtime() { return runtime; }, get store() { return store; },
    reopen() { runtime.close(); store.close(); open(); },
    plan(overrides = {}) {
      return { tenantId: "local", userId: "owner", ownerAgentId: runtime.workforce.rootId,
        reviewerAgentId: runtime.workforce.agents["Quality Reviewer"], objective: "Inspect repository evidence with independent review.",
        budget: { toolCalls: 4, wallTimeMs: 30_000 }, constraints: { privacy: "local_only" },
        steps: [{ agentId: runtime.workforce.agents["Engineering Worker"],
          calls: [{ tool: "repository.read", input: { path: "example.txt" }, outputSchema: { type: "string", const: "1\tverified repository evidence" } }] }], ...overrides };
    } };
}

test("objective delegates, executes, independently checks evidence, persists memory and reuses agents", async (t) => {
  const h = harness(t);
  const before = h.runtime.registry.listAgents("local").map((a) => a.id);
  const run = h.runtime.coordinator.create(h.plan());
  const completed = await h.runtime.coordinator.resume("local", run.taskId);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(h.store.getTask("local", run.taskId).status, "completed");
  const child = completed.steps[0];
  const artifact = h.store.getArtifact("local", child.artifacts[0]);
  assert.equal(artifact.verification, "verified");
  assert.ok(artifact.verificationEvidence.some((e) => e.reviewerAgentId === completed.reviewerAgentId));
  assert.notEqual(completed.reviewerAgentId, child.agentId);
  assert.equal(h.runtime.memory.get("local", { agentId: child.agentId }, child.memoryIds[0]).kind, "observation");
  assert.equal(h.store.getToolCalls("local", child.taskId).length, 1);
  assert.ok(h.store.listEvents("local", { correlationId: h.store.getTask("local", run.taskId).correlationId }).length > 5);
  h.reopen();
  assert.deepEqual(h.runtime.registry.listAgents("local").map((a) => a.id), before);
  assert.equal((await h.runtime.coordinator.resume("local", run.taskId)).status, "completed");
  assert.equal(h.store.getToolCalls("local", child.taskId).length, 1);
});

test("restart preserves queued assignments and requires explicit resume", async (t) => {
  const h = harness(t);
  const run = h.runtime.coordinator.create(h.plan());
  h.reopen();
  assert.equal(h.runtime.coordinator.get("local", run.taskId).status, "interrupted");
  assert.equal(h.store.getTask("local", run.taskId).status, "queued");
  assert.equal((await h.runtime.coordinator.resume("local", run.taskId)).status, "completed");
});

test("independent rejection blocks parent completion", async (t) => {
  const h = harness(t);
  const plan = h.plan();
  plan.steps[0].calls[0].outputSchema = { type: "integer" };
  const run = h.runtime.coordinator.create(plan);
  const result = await h.runtime.coordinator.resume("local", run.taskId);
  assert.equal(result.status, "failed", result.error);
  assert.equal(h.store.getTask("local", run.taskId).status, "failed");
  assert.equal(h.store.getArtifact("local", result.steps[0].artifacts[0]).verification, "rejected");
  assert.equal(result.steps[0].memoryIds.length, 0);
});

test("tenant isolation, reviewer separation, budgets and privacy fail before execution", (t) => {
  const h = harness(t);
  assert.throws(() => h.runtime.coordinator.create(h.plan({ tenantId: "other" })));
  const plan = h.plan();
  plan.reviewerAgentId = plan.steps[0].agentId;
  assert.throws(() => h.runtime.coordinator.create(plan), /distinct/);
  assert.throws(() => h.runtime.coordinator.create(h.plan({ budget: { toolCalls: 0, wallTimeMs: 100 } })), /budgets/);
  assert.throws(() => h.runtime.coordinator.create(h.plan({ constraints: { allowedProviders: ["anthropic"] } })), /No model/);
});

test("workforce routes refuse paired devices before reading or executing a plan", async (t) => {
  const h = harness(t);
  let status; let body;
  const response = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  await createWorkforceRoutes(h.runtime).handle({ url: "/v1/workforce", method: "GET" }, response, { role: "device" });
  assert.equal(status, 403);
  assert.match(body.message, /local owner/);
});

test("restart after a successful tool but before artifact commit replays without another execution", async (t) => {
  const h = harness(t);
  const run = h.runtime.coordinator.create(h.plan());
  h.store.submitArtifact = () => { throw new Error("Simulated interruption before artifact commit."); };
  const stopped = await h.runtime.coordinator.resume("local", run.taskId);
  assert.equal(stopped.status, "interrupted");
  const taskId = stopped.steps[0].taskId;
  const call = h.store.getToolCalls("local", taskId)[0];
  assert.equal(call.status, "succeeded");
  h.reopen();
  const completed = await h.runtime.coordinator.resume("local", run.taskId);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(h.store.getToolCalls("local", taskId).length, 1);
  assert.equal(h.store.getToolCalls("local", taskId)[0].id, call.id);
  assert.equal(h.store.getTask("local", taskId).usage.toolCalls, 1);
});

test("routed model execution uses the chosen profile, redacts secrets and charges durable token usage", async (t) => {
  let invoked;
  const h = harness(t, { modelClientFactory: ({ baseUrl }) => ({ async *stream(request) {
    invoked = { baseUrl, ...request };
    yield { type: "text", delta: "Bounded model result" };
    yield { type: "done", usage: { prompt_tokens: 14, completion_tokens: 6 } };
  } }) });
  const plan = h.plan({ budget: { toolCalls: 4, wallTimeMs: 30_000, inputTokens: 2000, outputTokens: 256 } });
  plan.steps[0].calls = [{ tool: "model.respond", input: { prompt: "api_key=secretvalue123", modelProfile: "untrusted", maxOutputTokens: 128 }, outputSchema: { type: "string", const: "Bounded model result" } }];
  const created = h.runtime.coordinator.create(plan);
  const completed = await h.runtime.coordinator.resume("local", created.taskId);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(invoked.model, "test-model");
  assert.equal(invoked.messages[0].content.includes("secretvalue123"), false);
  const child = h.store.getTask("local", completed.steps[0].taskId);
  assert.equal(child.usage.inputTokens, 14);
  assert.equal(child.usage.outputTokens, 6);
});

test("a worker is reserved while unfinished work exists and repeated resume shares one operation", async (t) => {
  const h = harness(t);
  const created = h.runtime.coordinator.create(h.plan());
  assert.throws(() => h.runtime.coordinator.create(h.plan()), /unfinished/);
  const first = h.runtime.coordinator.resume("local", created.taskId);
  const second = h.runtime.coordinator.resume("local", created.taskId);
  assert.equal(first, second);
  assert.equal((await first).status, "completed");
  assert.doesNotThrow(() => h.runtime.coordinator.create(h.plan()));
});

test("cancellation releases queued ownership and blocks a late running model result", async (t) => {
  let release; let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const h = harness(t, { modelClientFactory: () => ({ async *stream() {
    started(); await wait; yield { type: "text", delta: "late" };
  } }) });
  const queued = h.runtime.coordinator.create(h.plan());
  assert.equal(h.runtime.coordinator.cancel("local", queued.taskId).status, "cancelled");
  const plan = h.plan({ budget: { toolCalls: 4, wallTimeMs: 30_000, inputTokens: 2000, outputTokens: 256 } });
  plan.steps[0].calls = [{ tool: "model.respond", input: { prompt: "test" }, outputSchema: { type: "string" } }];
  const run = h.runtime.coordinator.create(plan);
  const operation = h.runtime.coordinator.resume("local", run.taskId);
  await ready;
  h.runtime.coordinator.cancel("local", run.taskId);
  release();
  const cancelled = await operation;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.steps[0].artifacts.length, 0);
  assert.equal(h.store.getTask("local", run.taskId).status, "cancelled");
});
