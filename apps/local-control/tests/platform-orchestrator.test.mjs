import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MissionScheduler } from "../src/agent/mission-scheduler.mjs";
import { PlatformTaskStore } from "../src/platform/index.mjs";
import { OutboxDispatcher } from "../src/platform/outbox-dispatcher.mjs";
import { OrchestratorStore, TaskControl, TaskDag } from "../src/platform/orchestrator/index.mjs";

const A = "tenant-a";
const B = "tenant-b";

async function harness(t, { start = "2026-01-05T10:00:00.000Z", maxOutboxAttempts = 5 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-orch-"));
  const time = { now: new Date(start).getTime() };
  const clock = () => new Date(time.now);
  const filename = join(directory, "platform.sqlite");
  const store = new PlatformTaskStore(filename, { clock, maxOutboxAttempts });
  const orch = new OrchestratorStore(join(directory, "orchestrator.sqlite"), { clock });
  t.after(async () => {
    store.close();
    orch.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store, orch, clock, filename, orchFilename: join(directory, "orchestrator.sqlite"),
    advance(ms) { time.now += ms; },
    set(iso) { time.now = new Date(iso).getTime(); },
  };
}

function newTask(store, overrides = {}) {
  return store.createTask({
    tenantId: A, userId: "user-1", agentId: "agent-1", objective: "Do a thing.",
    successCriteria: ["The thing is done."], budget: { toolCalls: 10 }, ...overrides,
  });
}

function moveTo(store, task, path) {
  for (const to of path) store.transitionTask(task.tenantId, task.id, to, { actor: "test" });
  return store.getTask(task.tenantId, task.id);
}
const TO_RUNNING = ["authorized", "queued", "running"];
const TO_COMPLETED = [...TO_RUNNING, "verifying", "completed"];

// ---------------------------------------------------------------------------
// DAG
// ---------------------------------------------------------------------------

test("dag refuses self-loops, cycles, cross-tenant edges and child-on-ancestor edges", async (t) => {
  const { store, orch } = await harness(t);
  const dag = new TaskDag({ store, orchestratorStore: orch });
  const a = newTask(store);
  const b = newTask(store);
  const c = newTask(store);
  dag.addDependency(A, b.id, a.id);
  dag.addDependency(A, c.id, b.id);
  assert.throws(() => dag.addDependency(A, a.id, c.id), (e) => e.code === "DEPENDENCY_CYCLE" && /cycle detected/u.test(e.details.cause));
  assert.throws(() => dag.addDependency(A, a.id, a.id), { code: "DEPENDENCY_CYCLE" });
  assert.deepEqual(dag.dependenciesOf(A, c.id), [b.id]);
  assert.deepEqual(dag.dependentsOf(A, a.id), [b.id]);

  const other = newTask(store, { tenantId: B });
  assert.throws(() => dag.addDependency(A, a.id, other.id), { code: "NOT_FOUND" });
  assert.throws(() => dag.addDependency(B, other.id, a.id), { code: "NOT_FOUND" });
  assert.deepEqual(dag.dependenciesOf(B, b.id), [], "tenant B cannot see tenant A's edges");

  const parent = newTask(store);
  const child = newTask(store, { parentTaskId: parent.id });
  const grandchild = newTask(store, { parentTaskId: child.id });
  assert.throws(() => dag.addDependency(A, grandchild.id, parent.id), { code: "DEPENDENCY_CYCLE" }, "the ancestor waits for the child");
  dag.addDependency(A, parent.id, grandchild.id); // redundant but acyclic
});

test("dag readiness: dependencies must complete and a parent waits for its children", async (t) => {
  const { store, orch } = await harness(t);
  const dag = new TaskDag({ store, orchestratorStore: orch });
  const a = newTask(store);
  const b = moveTo(store, newTask(store), ["authorized", "queued"]);
  dag.addDependency(A, b.id, a.id);
  let readiness = dag.readiness(A, b.id);
  assert.equal(readiness.state, "blocked");
  assert.deepEqual(readiness.waitingOn.map((w) => w.taskId), [a.id]);
  assert.deepEqual(dag.readyTasks(A), []);

  moveTo(store, a, TO_COMPLETED);
  assert.equal(dag.readiness(A, b.id).state, "ready");
  assert.deepEqual(dag.readyTasks(A).map((task) => task.id), [b.id]);

  // Parent parks while children run, and resumes once they finish.
  const parent = moveTo(store, newTask(store), TO_RUNNING);
  const kid1 = moveTo(store, newTask(store, { parentTaskId: parent.id }), TO_RUNNING);
  const kid2 = newTask(store, { parentTaskId: parent.id });
  assert.equal(dag.waitIfBlocked(A, parent.id).state, "blocked");
  assert.equal(store.getTask(A, parent.id).status, "waiting_for_dependency");
  assert.deepEqual(dag.sweep(A).resumed, []);

  store.transitionTask(A, kid1.id, "verifying", { actor: "t" });
  store.transitionTask(A, kid1.id, "completed", { actor: "t", result: { answer: 42 } });
  let partial = dag.partialResults(A, parent.id);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.summary, { total: 2, completed: 1, failed: 0, cancelled: 0, pending: 1 });
  assert.deepEqual(partial.items.find((i) => i.taskId === kid1.id).result, { answer: 42 });

  store.transitionTask(A, kid2.id, "failed", { actor: "t", error: { code: "X" } });
  const swept = dag.sweep(A);
  assert.deepEqual(swept.resumed, [parent.id]);
  assert.equal(store.getTask(A, parent.id).status, "running");
  partial = dag.partialResults(A, parent.id);
  assert.equal(partial.summary.failed, 1);
  assert.equal(partial.complete, false, "a failed child makes the result partial, reported truthfully");
});

test("dag sweep fails tasks with unsatisfiable dependencies and enforces deadlines", async (t) => {
  const { store, orch, advance } = await harness(t);
  const dag = new TaskDag({ store, orchestratorStore: orch });
  const dep = moveTo(store, newTask(store), TO_RUNNING);
  const waiter = moveTo(store, newTask(store), TO_RUNNING);
  dag.addDependency(A, waiter.id, dep.id);
  dag.waitIfBlocked(A, waiter.id);
  store.transitionTask(A, dep.id, "failed", { actor: "t" });
  assert.equal(dag.readiness(A, waiter.id).state, "unsatisfiable");
  assert.deepEqual(dag.sweep(A).failed, [waiter.id]);
  assert.equal(store.getTask(A, waiter.id).error.code, "DEPENDENCY_FAILED");

  const late = moveTo(store, newTask(store), TO_RUNNING);
  const queued = moveTo(store, newTask(store), ["authorized", "queued"]);
  dag.setDeadline(A, late.id, new Date(Date.parse("2026-01-05T10:05:00Z")).toISOString());
  dag.setDeadline(A, queued.id, "2026-01-05T10:05:00Z");
  assert.equal(dag.sweep(A).expired.length, 0);
  advance(6 * 60_000);
  const swept = dag.sweep(A);
  assert.deepEqual(swept.expired.sort(), [late.id, queued.id].sort());
  assert.equal(store.getTask(A, late.id).status, "failed");
  assert.equal(store.getTask(A, late.id).error.code, "DEADLINE_EXCEEDED");
  assert.equal(store.getTask(A, queued.id).status, "cancelled", "queued cannot fail, so it is cancelled");
  assert.throws(() => dag.setDeadline(A, late.id, "not a date"), { code: "INVALID_DEADLINE" });
});

test("dag hands a durable platform DAG to the mission scheduler, which runs it in dependency order", async (t) => {
  const { store, orch } = await harness(t);
  const dag = new TaskDag({ store, orchestratorStore: orch });
  const fetch = moveTo(store, newTask(store, { objective: "Fetch data." }), ["authorized", "queued"]);
  const parse = moveTo(store, newTask(store, { objective: "Parse data." }), ["authorized", "queued"]);
  const report = moveTo(store, newTask(store, { objective: "Write report." }), ["authorized", "queued"]);
  const already = moveTo(store, newTask(store, { objective: "Old input." }), TO_COMPLETED);
  dag.addDependency(A, parse.id, fetch.id);
  dag.addDependency(A, report.id, parse.id);
  dag.addDependency(A, report.id, already.id);

  const plan = dag.toMissionPlan(A);
  assert.deepEqual(new Set(plan.children.map((c) => c.id)), new Set([fetch.id, parse.id, report.id, already.id]), "completed dependencies are included so edges resolve");
  assert.deepEqual(plan.children.find((c) => c.id === report.id).dependencies.sort(), [parse.id, already.id].sort());

  const order = [];
  const mission = new MissionScheduler({
    plan,
    maxConcurrency: 2,
    execute: async ({ child }) => {
      if (child.metadata.status === "completed") return { status: "completed" };
      order.push(child.id);
      return { status: "completed", summary: `ran ${child.objective}` };
    },
  });
  const snapshot = await mission.start();
  assert.equal(snapshot.status, "completed");
  assert.deepEqual(order, [fetch.id, parse.id, report.id]);
  assert.throws(() => dag.toMissionPlan(A, ["tsk_does_not_exist"]), { code: "NOT_FOUND" });
});

test("outbox dead letters from the shared dispatcher become human escalations, once", async (t) => {
  const { store, orch } = await harness(t, { maxOutboxAttempts: 2 });
  const control = new TaskControl({ store, orchestratorStore: orch });
  const dispatcher = new OutboxDispatcher({ store, workerId: "d1" });
  dispatcher.subscribe("task.created", () => { throw new Error("downstream unavailable"); });
  const task = newTask(store);
  await dispatcher.drain();
  await dispatcher.drain();
  assert.equal(store.listOutbox({ status: "dead" }).length, 1);
  const opened = control.escalateDeadLetters();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].type, "ESCALATION");
  assert.equal(opened[0].requiresHuman, true);
  assert.equal(opened[0].details.lastError, "downstream unavailable");
  assert.equal(opened[0].correlationId, task.correlationId);
  assert.equal(control.escalateDeadLetters().length, 0, "escalation is idempotent per outbox row");
  assert.deepEqual(orch.listEscalations(B), [], "escalations are tenant-scoped");
  assert.throws(() => orch.resolveEscalation(A, opened[0].id, {}), { code: "RESOLVER_REQUIRED" });
  assert.equal(orch.resolveEscalation(A, opened[0].id, { resolvedBy: "ops@example", resolution: "redriven" }).status, "resolved");
});

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

test("cancel propagates to descendants and invokes worker-session cancel hooks", async (t) => {
  const { store, orch } = await harness(t);
  const control = new TaskControl({ store, orchestratorStore: orch });
  const parent = moveTo(store, newTask(store), TO_RUNNING);
  const child = moveTo(store, newTask(store, { parentTaskId: parent.id }), TO_RUNNING);
  const grandchild = moveTo(store, newTask(store, { parentTaskId: child.id }), ["authorized", "queued"]);
  const done = moveTo(store, newTask(store, { parentTaskId: parent.id }), TO_COMPLETED);
  const unrelated = moveTo(store, newTask(store), TO_RUNNING);
  const stopped = [];
  control.registerWorkerSession(A, grandchild.id, { sessionId: "browser-1", kind: "browser", cancel: ({ reason }) => { stopped.push(["browser-1", reason]); } });
  control.registerWorkerSession(A, child.id, { sessionId: "term-1", kind: "terminal", cancel: async () => { throw new Error("pty already gone"); } });
  orch.acquireLease(A, child.id, "loop-1", 60_000);

  const outcome = await control.cancel(A, parent.id, { actor: "ops", reason: "user changed their mind" });
  assert.deepEqual(outcome.cancelled.sort(), [parent.id, child.id, grandchild.id].sort());
  assert.deepEqual(outcome.skipped, [{ taskId: done.id, status: "completed" }]);
  for (const id of [parent.id, child.id, grandchild.id]) assert.equal(store.getTask(A, id).status, "cancelled");
  assert.equal(store.getTask(A, unrelated.id).status, "running");
  assert.equal(stopped.length, 1);
  assert.match(stopped[0][1], /parent .* cancelled: user changed their mind/u);
  const termHook = outcome.hooks.find((h) => h.sessionId === "term-1");
  assert.equal(termHook.ok, false);
  assert.equal(termHook.error, "pty already gone");
  assert.equal(orch.getLease(A, child.id), null, "cancellation releases the lease");
  assert.equal(orch.getControl(A, grandchild.id).cancelRequested, true);
  await assert.rejects(control.cancel(B, parent.id), { code: "NOT_FOUND" });
});

test("restart recovery re-queues orphaned running tasks and escalates repeat offenders", async (t) => {
  const { store, orch, advance } = await harness(t);
  const control = new TaskControl({ store, orchestratorStore: orch, maxRecoveries: 1 });
  const orphan = moveTo(store, newTask(store), TO_RUNNING);
  const alive = moveTo(store, newTask(store), TO_RUNNING);
  const neverLeased = moveTo(store, newTask(store, { tenantId: B }), TO_RUNNING);
  const cancelMe = moveTo(store, newTask(store), TO_RUNNING);
  orch.acquireLease(A, orphan.id, "old-process", 1_000);
  orch.saveCheckpoint(A, orphan.id, { step: 3 });
  orch.setControl(A, cancelMe.id, { cancelRequested: true });
  advance(2_000);
  orch.acquireLease(A, alive.id, "live-process", 60_000);

  let outcome = control.recover({ tenantIds: [B] });
  assert.deepEqual(outcome.requeued.sort(), [orphan.id, neverLeased.id].sort());
  assert.deepEqual(outcome.cancelled, [cancelMe.id]);
  assert.equal(store.getTask(A, orphan.id).status, "queued");
  assert.equal(store.getTask(A, orphan.id).error.code, "WORKER_LOST");
  assert.equal(store.getTask(A, orphan.id).error.checkpointStep, 3);
  assert.equal(store.getTask(A, alive.id).status, "running", "a task with a live lease is left alone");
  assert.deepEqual(orch.loadCheckpoint(A, orphan.id), { step: 3 }, "the checkpoint survives for the next worker");

  // It gets picked up, loses its worker again, and this time needs a human.
  store.transitionTask(A, orphan.id, "running", { actor: "loop" });
  outcome = control.recover();
  assert.equal(outcome.escalated.length, 1);
  assert.equal(outcome.escalated[0].taskId, orphan.id);
  assert.equal(store.getTask(A, orphan.id).status, "failed");
  const [escalation] = orch.listEscalations(A, { source: "recovery" });
  assert.equal(escalation.requiresHuman, true);
  assert.equal(control.recover().escalated.length, 0, "recovery is idempotent");
});

test("pause and resume set a durable control flag", async (t) => {
  const { store, orch } = await harness(t);
  const control = new TaskControl({ store, orchestratorStore: orch });
  const task = moveTo(store, newTask(store), TO_RUNNING);
  control.pause(A, task.id, { actor: "ops" });
  assert.equal(control.isPaused(A, task.id), true);
  control.resume(A, task.id);
  assert.equal(control.isPaused(A, task.id), false);
  const finished = moveTo(store, newTask(store), TO_COMPLETED);
  assert.throws(() => control.pause(A, finished.id), { code: "TASK_TERMINAL" });
});

test("pause, resume and cancel propagate into an attached mission scheduler and to descendants", async (t) => {
  const { store, orch } = await harness(t);
  const control = new TaskControl({ store, orchestratorStore: orch });
  const parent = moveTo(store, newTask(store), TO_RUNNING);
  const child = moveTo(store, newTask(store, { parentTaskId: parent.id }), TO_RUNNING);
  const aborted = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mission = new MissionScheduler({
    plan: { id: "work", children: [{ id: "one", dependencies: [] }, { id: "two", dependencies: ["one"] }] },
    execute: async ({ child: c, signal }) => {
      signal.addEventListener("abort", () => aborted.push([c.id, signal.reason?.name]));
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))]);
      return { status: "completed" };
    },
  });
  control.attachMission(A, child.id, mission);
  const done = mission.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(control.pause(A, parent.id, { actor: "ops" }).paused.sort(), [parent.id, child.id].sort());
  assert.equal(mission.status, "interrupted");
  assert.equal(control.isPaused(A, child.id), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mission.child("one").state, "interrupted");

  assert.deepEqual(control.resume(A, parent.id).resumed.sort(), [parent.id, child.id].sort());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mission.status, "running");

  const outcome = await control.cancel(A, parent.id, { reason: "stop everything" });
  assert.deepEqual(outcome.missions, [{ taskId: child.id, status: "cancelled" }]);
  const snapshot = await done;
  assert.equal(snapshot.status, "cancelled");
  assert.equal(mission.child("two").state, "cancelled");
  assert.ok(aborted.length >= 2, "running mission children saw their abort signal on pause and on cancel");
  release();
  assert.throws(() => control.attachMission(A, parent.id, {}), { code: "INVALID_MISSION" });
});
