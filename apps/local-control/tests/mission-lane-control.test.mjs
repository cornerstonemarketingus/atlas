import assert from "node:assert/strict";
import test from "node:test";

import { MissionScheduler } from "../src/agent/mission-scheduler.mjs";

const plan = (children) => ({ id: "lanes", title: "Lanes", children });
const lane = (id, dependencies = []) => ({ id, objective: id, dependencies });
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Cancelled after the test even when an assertion fails, so leftover lanes cannot hang the run. */
const track = (t, scheduler) => { t.after(() => scheduler.cancel()); return scheduler; };

/** An executor whose lanes run until released or aborted, like a real agent honouring its signal. */
function controllable() {
  const release = new Map();
  const started = [];
  const execute = ({ child, signal }) => new Promise((resolve, reject) => {
    started.push(child.id);
    release.set(child.id, (value = { summary: `${child.id} done` }) => resolve(value));
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return { execute, started, finish: (id, value) => release.get(id)?.(value) };
}

test("pausing one running lane leaves the others running and holds it until resumed", async (t) => {
  const agent = controllable();
  const scheduler = track(t, new MissionScheduler({ plan: plan([lane("a"), lane("b")]), maxConcurrency: 2, execute: agent.execute }));
  const done = scheduler.start();
  await tick();
  scheduler.controlChild("a", "pause");
  await tick();
  assert.equal(scheduler.child("a").state, "interrupted");
  assert.equal(scheduler.child("a").error.code, "CHILD_PAUSED");
  assert.equal(scheduler.child("b").state, "running", "the other lane is untouched");
  assert.equal(scheduler.status, "running");

  agent.finish("b");
  await tick();
  assert.equal(scheduler.status, "running", "the mission waits for the held lane instead of finishing");

  scheduler.controlChild("a", "resume");
  await tick();
  assert.equal(scheduler.child("a").state, "running");
  assert.equal(scheduler.child("a").attempts, 2);
  agent.finish("a");
  assert.equal((await done).status, "completed");
});

test("a held lane stays held through a mission pause and resume, and after a restart", async (t) => {
  const agent = controllable();
  const scheduler = track(t, new MissionScheduler({ plan: plan([lane("a"), lane("b"), lane("c")]), maxConcurrency: 1, execute: agent.execute }));
  scheduler.start();
  await tick();
  scheduler.controlChild("b", "pause");
  assert.equal(scheduler.child("b").state, "interrupted", "a pending lane can be parked before it starts");
  scheduler.pause();
  await tick();
  void scheduler.resume();
  await tick();
  assert.equal(scheduler.child("b").error?.code, "CHILD_PAUSED", "a mission-wide resume does not release it");

  const restored = track(t, MissionScheduler.restore({ snapshot: scheduler.snapshot(), execute: agent.execute }));
  restored.start();
  await tick();
  assert.equal(restored.child("b").state, "interrupted");
  assert.equal(restored.child("b").error?.code, "CHILD_PAUSED", "nor does a restart");
  scheduler.cancel();
  restored.cancel();
});

test("cancelling one lane blocks what depends on it but not its siblings", async (t) => {
  const agent = controllable();
  const scheduler = track(t, new MissionScheduler({ plan: plan([lane("a"), lane("b"), lane("after-a", ["a"])]), maxConcurrency: 2, execute: agent.execute }));
  const done = scheduler.start();
  await tick();
  scheduler.controlChild("a", "cancel");
  await tick();
  assert.equal(scheduler.child("a").state, "cancelled");
  assert.equal(scheduler.child("a").error.code, "CHILD_CANCELLED");
  assert.equal(scheduler.child("after-a").state, "blocked");
  assert.equal(scheduler.child("b").state, "running");
  agent.finish("b");
  const final = await done;
  assert.equal(final.status, "failed", "a mission with a cancelled lane did not complete everything");
  assert.equal(final.children.find((item) => item.id === "b").state, "completed");
});

test("retrying a failed lane reruns it and the lanes it blocked, keeping its usage", async (t) => {
  let fail = true;
  const started = [];
  const scheduler = track(t, new MissionScheduler({
    plan: plan([lane("a"), lane("after-a", ["a"])]),
    execute: async ({ child, budget }) => {
      started.push(child.id);
      budget.record({ toolCalls: 1 });
      if (child.id === "a" && fail) return { status: "failed", summary: "broken" };
      return { summary: "ok" };
    },
  }));
  const first = await scheduler.start();
  assert.equal(first.status, "failed");
  assert.equal(scheduler.child("after-a").state, "blocked");

  fail = false;
  scheduler.controlChild("a", "retry");
  await tick(); await tick(); await tick();
  assert.equal(scheduler.status, "completed");
  assert.deepEqual(started, ["a", "a", "after-a"]);
  assert.equal(scheduler.child("a").usage.toolCalls, 2, "a retry spends from the same budget");
});

test("lane control refuses what makes no sense", async (t) => {
  const agent = controllable();
  const scheduler = track(t, new MissionScheduler({ plan: plan([lane("a")]), execute: agent.execute }));
  scheduler.start();
  await tick();
  assert.throws(() => scheduler.controlChild("missing", "pause"), { code: "UNKNOWN_CHILD" });
  assert.throws(() => scheduler.controlChild("a", "resume"), { code: "INVALID_STATE" });
  assert.throws(() => scheduler.controlChild("a", "retry"), { code: "INVALID_STATE" });
  assert.throws(() => scheduler.controlChild("a", "explode"), { code: "INVALID_ACTION" });
  scheduler.cancel();
  await tick();
  assert.throws(() => scheduler.controlChild("a", "retry"), /whole mission was cancelled/);
});
