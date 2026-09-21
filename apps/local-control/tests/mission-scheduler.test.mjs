import assert from "node:assert/strict";
import test from "node:test";

import { MissionPlanError, MissionScheduler, normalizeMissionPlan } from "../src/agent/mission-scheduler.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const plan = (children) => ({ id: "launch", title: "Launch Atlas", children });
const child = (id, dependencies = [], extra = {}) => ({ id, objective: id, dependencies, ...extra });

test("plans require explicit dependencies and reject unknown, duplicate, self and cyclic edges", () => {
  assert.throws(() => normalizeMissionPlan(plan([{ id: "implicit" }])), (error) => error instanceof MissionPlanError && error.code === "IMPLICIT_DEPENDENCIES");
  assert.throws(() => normalizeMissionPlan(plan([child("a", ["missing"])])), (error) => error.code === "UNKNOWN_DEPENDENCY");
  assert.throws(() => normalizeMissionPlan(plan([child("a"), child("a")])), (error) => error.code === "DUPLICATE_CHILD");
  assert.throws(() => normalizeMissionPlan(plan([child("a", ["a"])])), (error) => error.code === "SELF_DEPENDENCY");
  assert.throws(() => normalizeMissionPlan(plan([child("a", ["b"]), child("b", ["a"])])), (error) => error.code === "DEPENDENCY_CYCLE");
});

test("children run in deterministic dependency order with bounded concurrency", async () => {
  const gates = new Map([["research", deferred()], ["design", deferred()]]);
  const started = [];
  let active = 0;
  let highWater = 0;
  const scheduler = new MissionScheduler({
    plan: plan([
      child("research"),
      child("design"),
      child("build", ["research", "design"]),
      child("verify", ["build"]),
    ]),
    maxConcurrency: 2,
    execute: async ({ child: current }) => {
      started.push(current.id);
      active += 1;
      highWater = Math.max(highWater, active);
      await gates.get(current.id)?.promise;
      active -= 1;
      return { summary: `${current.id} done` };
    },
  });

  const finished = scheduler.start();
  assert.deepEqual(started, ["research", "design"]);
  gates.get("design").resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["research", "design"], "build waits for every declared dependency");
  gates.get("research").resolve();
  const snapshot = await finished;

  assert.deepEqual(started, ["research", "design", "build", "verify"]);
  assert.equal(highWater, 2);
  assert.equal(snapshot.status, "completed");
  assert.ok(snapshot.children.every((item) => item.state === "completed"));
});

test("exclusive resource locks serialize conflicting children without consuming a slot", async () => {
  const firstGate = deferred();
  const otherGate = deferred();
  const started = [];
  const scheduler = new MissionScheduler({
    plan: plan([
      child("writer-a", [], { resourceLocks: ["repo:atlas"] }),
      child("writer-b", [], { resourceLocks: ["repo:atlas"] }),
      child("browser", [], { resourceLocks: ["browser:one"] }),
    ]),
    maxConcurrency: 2,
    execute: async ({ child: current }) => {
      started.push(current.id);
      if (current.id === "writer-a") await firstGate.promise;
      if (current.id === "browser") await otherGate.promise;
      return { ok: true };
    },
  });

  const finished = scheduler.start();
  assert.deepEqual(started, ["writer-a", "browser"], "the locked writer is skipped and the next runnable child uses the free slot");
  firstGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["writer-a", "browser", "writer-b"]);
  otherGate.resolve();
  assert.equal((await finished).status, "completed");
});

test("a failed child blocks all descendants but allows an independent branch to finish", async () => {
  const executed = [];
  const scheduler = new MissionScheduler({
    plan: plan([
      child("failed-root"),
      child("direct-child", ["failed-root"]),
      child("grandchild", ["direct-child"]),
      child("independent"),
    ]),
    maxConcurrency: 2,
    execute: async ({ child: current }) => {
      executed.push(current.id);
      return current.id === "failed-root" ? { status: "failed", summary: "tests failed" } : { ok: true };
    },
  });
  const snapshot = await scheduler.start();

  assert.equal(snapshot.status, "failed");
  assert.deepEqual(executed, ["failed-root", "independent"]);
  assert.equal(scheduler.child("direct-child").state, "blocked");
  assert.equal(scheduler.child("grandchild").state, "blocked");
  assert.match(scheduler.child("direct-child").error.message, /failed-root/u);
});

test("mission cancellation reaches running children and cancels pending descendants", async () => {
  const running = deferred();
  let sawAbort = false;
  const scheduler = new MissionScheduler({
    plan: plan([child("parent"), child("descendant", ["parent"])]),
    execute: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { sawAbort = true; running.resolve(); resolve({ status: "cancelled" }); }, { once: true });
    }),
  });
  const finished = scheduler.start();
  scheduler.cancel("Operator stopped it.");
  await running.promise;
  const snapshot = await finished;

  assert.equal(sawAbort, true);
  assert.equal(snapshot.status, "cancelled");
  assert.deepEqual(snapshot.children.map((item) => item.state), ["cancelled", "cancelled"]);
  assert.equal(snapshot.reason, "Operator stopped it.");
});

test("pause interrupts active children and resume requeues them without resetting usage", async () => {
  let attempts = 0;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const scheduler = new MissionScheduler({
    plan: plan([child("builder", [], { budget: { toolCalls: 2 } })]),
    execute: ({ signal, budget }) => {
      attempts += 1;
      budget.record({ toolCalls: 1 });
      if (attempts > 1) return Promise.resolve({ summary: "resumed safely" });
      firstStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  const finished = scheduler.start();
  await started;
  scheduler.pause("Operator takeover.");
  assert.equal(scheduler.status, "interrupted");
  await scheduler.resume();
  const snapshot = await finished;

  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.children[0].attempts, 2);
  assert.equal(snapshot.children[0].usage.toolCalls, 2);
  assert.equal(snapshot.children[0].result.summary, "resumed safely");
});

test("per-child budgets are isolated and a budget failure blocks only its dependency branch", async () => {
  const scheduler = new MissionScheduler({
    plan: plan([
      child("limited", [], { budget: { toolCalls: 1 } }),
      child("dependent", ["limited"]),
      child("independent", [], { budget: { toolCalls: 2 } }),
    ]),
    maxConcurrency: 2,
    execute: async ({ child: current, budget }) => {
      budget.record({ toolCalls: 1 });
      if (current.id === "limited") budget.record({ toolCalls: 1 });
      return { ok: true };
    },
  });
  const snapshot = await scheduler.start();

  assert.equal(snapshot.status, "failed");
  assert.equal(scheduler.child("limited").error.code, "BUDGET_EXCEEDED");
  assert.equal(scheduler.child("limited").usage.toolCalls, 1, "the rejected increment is not partially charged");
  assert.equal(scheduler.child("dependent").state, "blocked");
  assert.equal(scheduler.child("independent").state, "completed");
  assert.equal(scheduler.child("independent").usage.toolCalls, 1);
});

test("snapshots are JSON serializable and restart preserves usage while requeueing interrupted work", async () => {
  const gate = deferred();
  const original = new MissionScheduler({
    plan: plan([child("resume-me", [], { budget: { toolCalls: 3 } })]),
    execute: async ({ budget }) => { budget.record({ toolCalls: 2 }); await gate.promise; return { old: true }; },
  });
  original.start();
  await new Promise((resolve) => setImmediate(resolve));
  const persisted = JSON.parse(JSON.stringify(original.snapshot()));
  assert.equal(persisted.status, "running");
  assert.equal(persisted.children[0].state, "running");
  assert.equal(persisted.children[0].usage.toolCalls, 2);

  let restoredStart;
  const restored = MissionScheduler.restore({
    snapshot: persisted,
    execute: async ({ child: current, budget }) => {
      restoredStart = current;
      budget.record({ toolCalls: 1 });
      return { resumed: true };
    },
  });
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.child("resume-me").state, "interrupted");
  const final = await restored.start();

  assert.equal(final.status, "completed");
  assert.equal(restoredStart.attempts, 2);
  assert.equal(final.children[0].usage.toolCalls, 3, "restart did not grant a fresh child budget");
  assert.deepEqual(final.children[0].result, { resumed: true });
  gate.resolve();
});

test("elapsed-time budgets abort a child that does not finish", async () => {
  const scheduler = new MissionScheduler({
    plan: plan([child("slow", [], { budget: { elapsedMs: 20 } })]),
    execute: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const snapshot = await scheduler.start();
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.children[0].state, "failed");
  assert.equal(snapshot.children[0].error.code, "BUDGET_EXCEEDED");
  assert.equal(snapshot.children[0].usage.elapsedMs, 20);
});
