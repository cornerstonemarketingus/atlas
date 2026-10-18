import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GoalService, GoalStore } from "../src/agent/goals.mjs";
import { MissionService } from "../src/agent/mission-service.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const input = (extra = {}) => ({ objective: "Finish PR 42", repository: "/work/app", model: "m", watch: { repository: "acme/app", pullRequest: 42 }, ...extra });
const event = (extra = {}) => ({ source: "github", event: "check_suite", conclusion: "failure", repository: "acme/app", pullRequests: [42], ...extra });

function missions() {
  const rows = new Map();
  const stopped = [];
  return {
    rows, stopped,
    create() { const row = { id: `mission-${rows.size + 1}`, status: "running" }; rows.set(row.id, row); return row; },
    get(id) { return rows.get(id) ?? null; },
    control(id, action) { assert.equal(action, "cancel"); stopped.push(id); const row = rows.get(id); row.status = "cancelled"; return row; },
  };
}

test("cancel, expiry and achievement stop only the goal's active mission and discard queued wakes", async (t) => {
  for (const finish of ["cancel", "expire", "achieve"]) await t.test(finish, (t) => {
    const store = new GoalStore();
    t.after(() => store.close());
    const service = missions();
    let now = Date.parse("2030-01-01T00:00:00Z");
    const goals = new GoalService({ store, missionService: service, clock: () => now });
    const goal = goals.create(input({ expiresInHours: 1 }));
    const unrelated = service.create();
    goals.onEvent(event());
    assert.ok(goals.get(goal.id).pendingWake);
    if (finish === "cancel") goals.cancel(goal.id);
    if (finish === "expire") { now += 3_600_000; goals.tick(); }
    if (finish === "achieve") goals.onEvent(event({ event: "pull_request", action: "closed", merged: true }));
    const ended = goals.get(goal.id);
    assert.equal(ended.state, { cancel: "cancelled", expire: "expired", achieve: "achieved" }[finish]);
    assert.equal(service.get(goal.missionId).status, "cancelled");
    assert.equal(service.get(unrelated.id).status, "running");
    assert.deepEqual(service.stopped, [goal.missionId]);
    assert.equal(ended.missionStopPending, false);
    assert.equal(ended.pendingWake, null);
    assert.equal(ended.missionId, goal.missionId, "retain the mission's identity as evidence");
    goals.tick();
    goals.cancel(goal.id);
    goals.onEvent(event());
    assert.equal(service.rows.size, 2);
    assert.deepEqual(service.stopped, [goal.missionId], "terminal repeats do not send more controls");
    assert.ok(ended.history.some((entry) => entry.kind === "mission_stopped"));
  });
});

test("completed or missing missions and sleeping goals require no cancellation", (t) => {
  const store = new GoalStore();
  t.after(() => store.close());
  const service = missions();
  const goals = new GoalService({ store, missionService: service });
  for (const state of ["completed", "failed", "cancelled", "missing"]) {
    const goal = goals.create(input());
    if (state === "missing") service.rows.delete(goal.missionId);
    else service.get(goal.missionId).status = state;
    assert.equal(goals.cancel(goal.id).missionStopPending, false);
    if (state !== "missing") assert.equal(service.get(goal.missionId).status, state);
  }
  assert.equal(goals.cancel(goals.create(input({ startNow: false })).id).state, "cancelled");
  assert.deepEqual(service.stopped, []);
});

test("failed stop intent survives database reopen and retries without waking the ended goal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-goal-stop-"));
  const filename = join(directory, "goals.sqlite");
  let store = new GoalStore(filename);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const service = missions();
  const stop = service.control;
  service.control = () => { throw new Error("private backend failure"); };
  let goals = new GoalService({ store, missionService: service });
  const goal = goals.create(input());
  goals.onEvent(event());
  assert.throws(() => goals.cancel(goal.id), (error) => error.code === "MISSION_STOP_FAILED" && !error.message.includes("private backend"));
  assert.equal(goals.get(goal.id).state, "cancelled");
  assert.equal(goals.get(goal.id).missionStopPending, true);
  assert.equal(goals.get(goal.id).pendingWake, null);
  store.close();
  store = new GoalStore(filename);
  goals = new GoalService({ store, missionService: service });
  assert.doesNotThrow(() => goals.tick(), "one refused stop must not prevent the daemon's other ticks");
  assert.equal(goals.get(goal.id).missionStopPending, true);
  service.control = stop;
  goals.tick();
  assert.equal(goals.get(goal.id).missionStopPending, false);
  assert.equal(service.get(goal.missionId).status, "cancelled");
  assert.equal(service.rows.size, 1);
  assert.deepEqual(service.stopped, [goal.missionId]);
  assert.equal(goals.get(goal.id).state, "cancelled");
});

test("a refused expiry stop does not prevent other goals expiring; unacknowledged controls stay pending", (t) => {
  const store = new GoalStore();
  t.after(() => store.close());
  const service = missions();
  let now = Date.parse("2030-01-01T00:00:00Z");
  const goals = new GoalService({ store, missionService: service, clock: () => now });
  const first = goals.create(input({ expiresInHours: 1 }));
  const second = goals.create(input({ expiresInHours: 1 }));
  const stop = service.control;
  service.control = function (id, action) { return id === first.missionId ? this.get(id) : stop.call(this, id, action); };
  now += 3_600_000;
  assert.doesNotThrow(() => goals.tick());
  assert.equal(goals.get(first.id).state, "expired");
  assert.equal(goals.get(first.id).missionStopPending, true);
  assert.equal(goals.get(second.id).state, "expired");
  assert.equal(service.get(second.missionId).status, "cancelled");
  service.control = stop;
  goals.tick();
  assert.equal(goals.get(first.id).missionStopPending, false);
  assert.equal(service.get(first.missionId).status, "cancelled");
});

test("a refused stop does not lose a deduplicated completion event for later goals", (t) => {
  const store = new GoalStore();
  t.after(() => store.close());
  const service = missions();
  const goals = new GoalService({ store, missionService: service });
  const first = goals.create(input());
  const second = goals.create(input());
  const stop = service.control;
  let calls = 0;
  service.control = function (id, action) {
    if (++calls === 1) throw new Error("stop refused");
    return stop.call(this, id, action);
  };
  const merged = event({ event: "pull_request", action: "closed", merged: true, delivery: "shared-merge" });
  assert.equal(goals.onEvent(merged).length, 2);
  assert.equal(goals.get(first.id).state, "achieved");
  assert.equal(goals.get(second.id).state, "achieved");
  const pending = [first, second].filter((goal) => goals.get(goal.id).missionStopPending);
  assert.equal(pending.length, 1);
  assert.deepEqual(goals.onEvent(merged), [], "the delivery is not replayed to compensate for a failed stop");
  service.control = stop;
  goals.tick();
  assert.equal(goals.get(pending[0].id).missionStopPending, false);
  assert.ok([first, second].every((goal) => service.get(goal.missionId).status === "cancelled"));
});

test("owner HTTP cancellation aborts a real mission; unauthenticated and paired devices cannot cancel", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-goal-http-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const goalStore = new GoalStore(join(directory, "goals.sqlite"));
  let started;
  const executing = new Promise((resolve) => { started = resolve; });
  let executionSignal;
  const service = new MissionService({ store, execute: async ({ signal }) => {
    executionSignal = signal;
    started();
    await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
    return { ok: false, cancelled: true, summary: "Cancelled" };
  } });
  const goals = new GoalService({ store: goalStore, missionService: service });
  const server = createLocalControlServer({ store, token: TOKEN, goals, missionService: service, runTask: async () => ({ ok: true }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const mission of service.list()) if (!["completed", "failed", "cancelled"].includes(mission.status)) service.control(mission.id, "cancel");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => server.close(resolve));
    goalStore.close(); store.close(); await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const response = await fetch(`${origin}/v1/goals`, { method: "POST", headers: admin, body: JSON.stringify(input()) });
  assert.equal(response.status, 201);
  const { goal } = await response.json();
  await executing;
  const url = `${origin}/v1/goals/${goal.id}`;
  assert.equal((await fetch(url, { method: "DELETE" })).status, 401);
  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers: admin })).json();
  const { deviceToken } = await (await fetch(`${origin}/v1/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Phone" }) })).json();
  assert.equal((await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${deviceToken}` } })).status, 403);
  assert.equal(executionSignal.aborted, false);
  const cancelled = await fetch(url, { method: "DELETE", headers: admin });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).goal.state, "cancelled");
  assert.equal(executionSignal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.get(goal.missionId).status, "cancelled");
  assert.ok(service.get(goal.missionId).children.every((child) => child.state === "cancelled"));
  assert.equal((await fetch(url, { method: "DELETE", headers: admin })).status, 200);
  goals.tick();
  assert.equal(service.list().length, 1);
  // Exercise the public error contract without leaking an execution backend's error.
  const next = goals.create(input());
  const control = service.control.bind(service);
  service.control = () => { throw new Error("private backend failure"); };
  let failed;
  try { failed = await fetch(`${origin}/v1/goals/${next.id}`, { method: "DELETE", headers: admin }); }
  finally { service.control = control; }
  assert.equal(failed.status, 503);
  const error = await failed.json();
  assert.equal(error.code, "MISSION_STOP_FAILED");
  assert.equal(JSON.stringify(error).includes("private backend"), false);
  assert.equal(goals.get(next.id).missionStopPending, true);
  const retried = await fetch(`${origin}/v1/goals/${next.id}`, { method: "DELETE", headers: admin });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).goal.missionStopPending, false);
});
