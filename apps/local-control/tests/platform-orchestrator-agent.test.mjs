import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthorizedToolExecutor, PlatformTaskStore, PolicyEngine } from "../src/platform/index.mjs";
import { ModelCapabilityRegistry } from "../src/platform/models/capabilities.mjs";
import { CapabilityRouter } from "../src/platform/models/router.mjs";
import { AgentLoop, OrchestratorStore, TaskControl, replayExecution } from "../src/platform/orchestrator/index.mjs";

const A = "tenant-a";
const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";

async function harness(t, { tools = ["echo", "send", "flaky"], limits = {}, modelClient } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-orch-agent-"));
  const filename = join(directory, "platform.sqlite");
  const store = new PlatformTaskStore(filename);
  const orch = new OrchestratorStore(join(directory, "orchestrator.sqlite"));
  const policy = new PolicyEngine({ version: "test.1", rules: [] });
  const executor = new AuthorizedToolExecutor({ store, policy });
  let flakyFailures = 2;
  if (tools.includes("echo")) {
    executor.register({
      name: "demo.echo", description: "Echo text.", risk: "read",
      inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 100 } } },
      execute: async ({ text }) => ({ output: { text }, evidence: [{ kind: "echo", length: text.length }], usage: { costMicroUsd: 3 } }),
    });
  }
  if (tools.includes("send")) {
    executor.register({
      name: "demo.send", description: "Send a message (consequential).", risk: "moderate", consequential: true,
      inputSchema: { type: "object", additionalProperties: false, required: ["to"], properties: { to: { type: "string" } } },
      execute: async ({ to }) => ({ output: { sent: true, to }, evidence: [{ kind: "receipt", to }] }),
    });
  }
  if (tools.includes("flaky")) {
    executor.register({
      name: "demo.flaky", description: "Fails transiently twice.", risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        if (flakyFailures > 0) { flakyFailures -= 1; const e = new Error("temporarily unavailable"); e.code = "UNAVAILABLE"; e.retryable = true; throw e; }
        return { output: { ok: true } };
      },
    });
  }
  const model = modelClient ?? scriptedModel({});
  const loop = new AgentLoop({ store, executor, orchestratorStore: orch, modelClient: model, limits });
  t.after(async () => {
    store.close();
    orch.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, orch, executor, loop, model, filename };
}

/** A fake model: per-model queues of scripted responses, recording every call. */
function scriptedModel(script) {
  const queues = Object.fromEntries(Object.entries(script).map(([model, items]) => [model, [...items]]));
  const calls = [];
  return {
    calls,
    queues,
    async complete({ model, messages, tools }) {
      calls.push({ model, messages, tools: tools.map((tool) => tool.name) });
      const next = queues[model]?.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next({ messages });
      return next ?? { content: "I am done and everything worked perfectly." };
    },
  };
}

const call = (name, args, usage = { inputTokens: 100, outputTokens: 20, costMicroUsd: 7 }) => ({ toolCalls: [{ name, arguments: args }], usage });
const finish = (summary = "Echoed hello.") => call("task.finish", { summary });

function queuedTask(store, overrides = {}) {
  const task = store.createTask({
    tenantId: A, userId: "user-1", agentId: "agent-1", objective: "Echo hello back.",
    successCriteria: ["An echo of hello exists."], budget: { toolCalls: 10 }, ...overrides,
  });
  store.transitionTask(A, task.id, "authorized", { actor: "test" });
  store.transitionTask(A, task.id, "queued", { actor: "test" });
  return task;
}

const echoVerifier = {
  name: "echo_output",
  criterion: "An echo of hello exists.",
  check: ({ evidence }) => {
    const hit = evidence.find((e) => e.tool === "demo.echo" && e.output?.text === "hello");
    return hit ? { ok: true, evidence: [{ check: "echo_output", toolCallId: hit.toolCallId, text: hit.output.text }] } : { ok: false, evidence: [], reason: "no echo of hello" };
  },
};

const runArgs = (task, extra = {}) => ({
  tenantId: A, taskId: task.id, userId: "user-1", grantedPermissions: ["demo.*"], verifiers: [echoVerifier], models: ["m1"], ...extra,
});

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

test("agent loop happy path: tool call, finish, verified completion with an evidence artifact", async (t) => {
  const model = scriptedModel({ m1: [call("demo.echo", { text: "hello" }), finish()] });
  const { store, orch, loop } = await harness(t, { modelClient: model });
  const task = queuedTask(store);
  const result = await loop.run(runArgs(task));
  assert.equal(result.status, "completed");
  assert.equal(result.steps, 2);
  const done = store.getTask(A, task.id);
  assert.equal(done.status, "completed");
  assert.equal(done.result.verificationArtifactId, result.verificationArtifactId);
  const artifact = store.getArtifact(A, result.verificationArtifactId);
  assert.equal(artifact.verification, "verified");
  assert.ok(artifact.verificationEvidence.some((e) => e.check === "echo_output"));
  assert.deepEqual(model.calls[0].tools.sort(), ["demo.echo", "demo.flaky", "demo.send", "task.finish"]);
  assert.match(model.calls[1].messages.at(-1).content, /"text":"hello"/u, "the tool observation is fed back");
  assert.equal(orch.getLease(A, task.id), null, "the lease is released");
  assert.equal(orch.loadCheckpoint(A, task.id), null, "the checkpoint is cleared on completion");
  assert.deepEqual(store.getTask(A, task.id).usage.inputTokens, 200, "model usage is charged to the task budget");
});

test("invalid model output is retried, then the router's fallback model takes over", async (t) => {
  const registry = new ModelCapabilityRegistry([
    { id: "weak", provider: "ollama", local: true, capabilities: { toolCalls: true }, reliability: 0.5, costPerMTokIn: 0, costPerMTokOut: 0 },
    { id: "strong", provider: "ollama", local: true, capabilities: { toolCalls: true }, reliability: 0.95, costPerMTokIn: 1, costPerMTokOut: 1 },
  ]);
  const router = new CapabilityRouter(registry);
  const model = scriptedModel({
    weak: [{ toolCalls: ["```json\n{not json"] }, { toolCalls: [{ name: "demo.nope", arguments: {} }] }],
    strong: [call("demo.echo", { text: "hello" }), finish()],
  });
  const directory = await mkdtemp(join(tmpdir(), "atlas-orch-agent-"));
  const store = new PlatformTaskStore(join(directory, "p.sqlite"));
  const orch = new OrchestratorStore(join(directory, "o.sqlite"));
  t.after(async () => { store.close(); orch.close(); await rm(directory, { recursive: true, force: true }); });
  const executor = new AuthorizedToolExecutor({ store, policy: new PolicyEngine({ version: "v", rules: [] }) });
  executor.register({
    name: "demo.echo", description: "Echo.", risk: "read",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    execute: async ({ text }) => ({ output: { text } }),
  });
  const loop = new AgentLoop({ store, executor, orchestratorStore: orch, modelClient: model, router });
  const task = queuedTask(store);
  const result = await loop.run({ ...runArgs(task, { models: undefined }), routing: { task: { complexity: "simple", needs: { toolCalls: true } }, constraints: { privacy: "local_only" } } });
  assert.equal(result.status, "completed");
  assert.deepEqual(model.calls.map((c) => c.model), ["weak", "weak", "strong", "strong"]);
  const correction = model.calls[1].messages.at(-1).content;
  assert.match(correction, /model_invalid_output/u, "the model is told why its output was refused");
});

test("every model producing prose instead of tool calls escalates; success is never inferred from prose", async (t) => {
  const model = scriptedModel({ m1: [{ content: "All done! It worked." }, { content: "Seriously, it is finished." }], m2: [{ content: "Done." }, { content: "Done!" }] });
  const { store, orch, loop } = await harness(t, { modelClient: model });
  const task = queuedTask(store);
  const result = await loop.run(runArgs(task, { models: ["m1", "m2"] }));
  assert.equal(result.status, "escalated");
  assert.equal(result.errorClass, "model_invalid_output");
  const failed = store.getTask(A, task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "ESCALATED");
  const [escalation] = orch.listEscalations(A, { taskId: task.id });
  assert.equal(escalation.requiresHuman, true);
  assert.equal(escalation.source, "agent_loop");
  assert.equal(store.listArtifacts(A, { taskId: task.id }).length, 0);
});

test("the loop refuses completion when a verifier passes without evidence, or no verifier covers a criterion", async (t) => {
  const model = scriptedModel({ m1: [call("demo.echo", { text: "hello" }), finish(), finish("Really done."), finish("Trust me.")] });
  const { store, loop } = await harness(t, { modelClient: model, limits: { maxVerificationFailures: 1 } });
  const task = queuedTask(store);
  const lazy = { name: "lazy", criterion: "An echo of hello exists.", check: () => ({ ok: true, evidence: [] }) };
  const result = await loop.run(runArgs(task, { verifiers: [lazy] }));
  assert.equal(result.status, "escalated");
  assert.equal(result.errorClass, "verification_failed");
  assert.notEqual(store.getTask(A, task.id).status, "completed");
  const feedback = model.calls[2].messages.at(-1).content;
  assert.match(feedback, /verifier passed without producing evidence/u);

  const model2 = scriptedModel({ m1: [call("demo.echo", { text: "hello" }), finish()] });
  const h2 = await harness(t, { modelClient: model2 });
  const task2 = queuedTask(h2.store, { successCriteria: ["An echo of hello exists.", "A second, unverified criterion."] });
  const uncovered = await h2.loop.run(runArgs(task2));
  assert.equal(uncovered.status, "escalated");
  assert.equal(h2.store.getTask(A, task2.id).status, "failed");
  const [escalation] = h2.orch.listEscalations(A, { taskId: task2.id });
  assert.deepEqual(escalation.details.uncoveredCriteria, ["A second, unverified criterion."]);
});

test("approval pauses the loop in waiting_for_approval and a later run resumes the approved call", async (t) => {
  const model = scriptedModel({ m1: [call("demo.send", { to: "ops" }), finish("Sent.")] });
  const { store, loop } = await harness(t, { modelClient: model });
  const task = queuedTask(store, { successCriteria: ["The message was sent."] });
  const sentVerifier = {
    criterion: "The message was sent.",
    check: ({ evidence }) => {
      const sent = evidence.find((e) => e.tool === "demo.send" && e.output?.sent === true);
      return { ok: Boolean(sent), evidence: sent ? [{ check: "receipt", toolCallId: sent.toolCallId }] : [] };
    },
  };
  const args = runArgs(task, { verifiers: [sentVerifier] });
  const first = await loop.run(args);
  assert.equal(first.status, "waiting_for_approval");
  assert.equal(store.getTask(A, task.id).status, "waiting_for_approval");

  const again = await loop.run(args);
  assert.equal(again.status, "waiting_for_approval", "still pending: nothing runs");
  assert.equal(model.calls.length, 1);

  store.resolveApproval(A, first.approvalId, { decision: "approved", resolvedBy: "human-1" });
  const resumed = await loop.run(args);
  assert.equal(resumed.status, "completed");
  assert.equal(store.getToolCall(A, first.toolCallId).status, "succeeded", "the very call that asked is the one that ran");
  const report = replayExecution(store, A, task.id);
  assert.equal(report.consistent, true, JSON.stringify(report.issues));
  assert.equal(report.approvals[0].status, "approved");
});

test("budget exhaustion escalates instead of looping", async (t) => {
  const model = scriptedModel({ m1: [call("demo.echo", { text: "one" }), call("demo.echo", { text: "two" }), finish()] });
  const { store, orch, loop } = await harness(t, { modelClient: model });
  const task = queuedTask(store, { budget: { toolCalls: 1 } });
  const result = await loop.run(runArgs(task));
  assert.equal(result.status, "escalated");
  assert.equal(result.errorClass, "budget_exceeded");
  assert.equal(store.getTask(A, task.id).status, "failed");
  assert.equal(orch.listEscalations(A, { taskId: task.id })[0].requiresHuman, true);
  const messages = store.listEvents(A, { taskId: task.id }).filter((e) => e.type === "agent.message");
  assert.equal(messages[0].payload.messageType, "ESCALATION");
});

test("retryable tool errors are retried within bounds; repeated policy denials escalate", async (t) => {
  const model = scriptedModel({ m1: [call("demo.flaky", {}), call("demo.echo", { text: "hello" }), finish()] });
  const { store, loop } = await harness(t, { modelClient: model });
  const task = queuedTask(store);
  const result = await loop.run(runArgs(task));
  assert.equal(result.status, "completed");
  const flaky = store.getToolCalls(A, task.id).filter((c) => c.tool === "demo.flaky");
  assert.deepEqual(flaky.map((c) => c.status), ["failed", "failed", "succeeded"]);

  const denied = scriptedModel({ m1: [call("demo.echo", { text: "a" }), call("demo.echo", { text: "b" }), call("demo.echo", { text: "c" })] });
  const h2 = await harness(t, { modelClient: denied, limits: { maxPolicyDenials: 1 } });
  const task2 = queuedTask(h2.store);
  const escalated = await h2.loop.run(runArgs(task2, { grantedPermissions: ["other.*"] }));
  assert.equal(escalated.errorClass, "policy_denied");
  assert.equal(h2.store.getToolCalls(A, task2.id).every((c) => c.status === "denied"), true);
});

test("a paused or cancelled task is not driven, and restart recovery resumes from the checkpoint", async (t) => {
  let hang;
  const model = scriptedModel({
    m1: [call("demo.echo", { text: "hello" }), () => new Promise((resolve) => { hang = resolve; })],
    m2: [finish()],
  });
  const { store, orch, executor, loop } = await harness(t, { modelClient: model, limits: { leaseTtlMs: 1_000 } });
  const control = new TaskControl({ store, orchestratorStore: orch });

  const paused = queuedTask(store);
  store.transitionTask(A, paused.id, "running", { actor: "t" });
  control.pause(A, paused.id);
  assert.equal((await loop.run(runArgs(paused))).status, "paused");
  assert.equal(model.calls.length, 0);
  await control.cancel(A, paused.id);
  assert.equal((await loop.run(runArgs(paused))).status, "cancelled");

  // A worker takes step 1 and then "dies" mid model call (the promise never settles).
  const task = queuedTask(store);
  void loop.run(runArgs(task));
  for (let i = 0; i < 20 && model.calls.length < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(model.calls.length, 2);
  assert.equal(orch.loadCheckpoint(A, task.id).step, 1);
  assert.equal(control.recover().requeued.length, 0, "a live lease protects the running worker");

  orch.db.prepare("UPDATE task_leases SET expires_at = ? WHERE task_id = ?").run("2000-01-01T00:00:00.000Z", task.id);
  const recovered = control.recover();
  assert.deepEqual(recovered.requeued, [task.id]);
  assert.equal(store.getTask(A, task.id).status, "queued");

  const second = new AgentLoop({ store, executor, orchestratorStore: orch, modelClient: model, owner: "loop-2" });
  const result = await second.run(runArgs(task, { models: ["m2"] }));
  assert.equal(result.status, "completed");
  assert.equal(result.steps, 2, "step count continues from the checkpoint");
  assert.equal(store.getToolCalls(A, task.id).length, 1, "the echo was not repeated");
  assert.equal(typeof hang, "function");
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test("replay reconstructs the timeline, accounts cost, and redacts secrets", async (t) => {
  const model = scriptedModel({ m1: [call("demo.echo", { text: `key ${SECRET}` }), call("demo.echo", { text: "hello" }), finish()] });
  const { store, loop } = await harness(t, { modelClient: model });
  const task = queuedTask(store);
  assert.equal((await loop.run(runArgs(task))).status, "completed");
  const report = replayExecution(store, A, task.id);
  assert.equal(report.consistent, true, JSON.stringify(report.issues));
  assert.equal(report.status, "completed");
  assert.deepEqual(report.transitions.map((tr) => tr.to), ["authorized", "queued", "running", "verifying", "completed"]);
  assert.equal(report.toolCalls.length, 2);
  assert.equal(report.toolCalls[0].decisions[0].effect, "allow");
  assert.equal(report.cost.toolCalls, 2);
  assert.equal(report.cost.inputTokens, 300);
  assert.equal(report.cost.costMicroUsd, 3 * 7 + 2 * 3);
  assert.deepEqual(report.usage.recomputed, report.usage.recorded);
  assert.ok(report.timeline.some((e) => e.type === "artifact.verified"));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(SECRET), false, "secrets never appear in a replay report");
  assert.match(serialized, /REDACTED/u);
  assert.equal(replayExecution(store, "tenant-b", task.id).found, false, "replay is tenant-scoped");
});

test("replay detects tampering with artifacts, tool calls, task status and usage", async (t) => {
  const model = scriptedModel({ m1: [call("demo.echo", { text: "hello" }), finish()] });
  const { store, loop, filename } = await harness(t, { modelClient: model });
  const task = queuedTask(store);
  await loop.run(runArgs(task));
  assert.equal(replayExecution(store, A, task.id).consistent, true);

  const raw = new DatabaseSync(filename);
  raw.prepare("UPDATE artifacts SET content_json = ? WHERE task_id = ?").run(JSON.stringify({ forged: true }), task.id);
  raw.prepare("UPDATE tool_calls SET status = 'failed' WHERE task_id = ?").run(task.id);
  raw.prepare("UPDATE tasks SET status = 'running', usage_json = ? WHERE id = ?").run(JSON.stringify({ toolCalls: 0 }), task.id);
  raw.prepare("DELETE FROM task_transitions WHERE task_id = ? AND to_status = 'verifying'").run(task.id);
  assert.throws(() => raw.prepare("DELETE FROM events WHERE task_id = ?").run(task.id), /append-only/u);
  raw.close();

  const report = replayExecution(store, A, task.id);
  assert.equal(report.consistent, false);
  const codes = new Set(report.issues.map((i) => i.code));
  for (const code of ["ARTIFACT_TAMPERED", "TOOL_CALL_STATUS_MISMATCH", "STATUS_MISMATCH", "TRANSITION_LOG_MISMATCH", "USAGE_MISMATCH"]) {
    assert.ok(codes.has(code), `expected ${code} in ${[...codes].join(", ")}`);
  }
});
