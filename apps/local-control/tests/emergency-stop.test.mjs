import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MissionService } from "../src/agent/mission-service.mjs";
import { AutomationService, AutomationStore } from "../src/platform/automations/service.mjs";
import { createEmergencyStop } from "../src/platform/emergency-stop.mjs";
import { LocalTaskStore } from "../src/store.mjs";

async function tempStore(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-estop-unit-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}

const waitFor = async (predicate, ms = 5000) => {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};

test("one failing service is reported and never stops the others; a second press stops nothing new", async (t) => {
  const { store } = await tempStore(t);
  const approval = store.createApproval({ capability: "terminal.run", summary: "Run a command" });
  const decided = [];
  const stop = createEmergencyStop({
    store,
    missionService: { cancelAll: () => { throw new Error("mission store is locked"); } },
    runtime: { cancelAll: () => ({ cancelled: ["s1"], failed: [{ id: "s2", error: "stuck" }] }), denyApproval: () => {} },
    render: { cancelAll: () => ({ cancelled: [] }) },
    onApprovalDecided: async (a) => { decided.push(a.id); },
  });
  const summary = await stop({ actor: "owner", reason: "emergency stop: unit" });
  assert.equal(summary.ok, false);
  assert.equal(summary.services.missions.status, "failed");
  assert.match(summary.services.missions.failed[0].error, /locked/u);
  assert.equal(summary.services.sessions.status, "partial");
  assert.equal(summary.services.renders.status, "idle");
  assert.equal(summary.services.genesis.status, "not_running");
  assert.equal(summary.services.compute.status, "not_running");
  // Approvals are still denied although an earlier service threw.
  assert.deepEqual(summary.services.approvals.stopped, [approval.id]);
  assert.equal(store.approval(approval.id).status, "denied");
  assert.deepEqual(decided, [approval.id]);
  assert.ok(store.auditEvents().some((e) => e.category === "emergency_stop.services" && /missions failed/u.test(e.summary)));
  assert.ok(store.auditEvents().some((e) => e.category === "approval.decided" && e.summary.includes("emergency stop: unit")));

  const again = await stop({ reason: "emergency stop" });
  assert.equal(again.services.approvals.status, "idle");
  assert.equal(again.services.approvals.stopped.length, 0);
});

test("two presses at once share one stop", async (t) => {
  const { store } = await tempStore(t);
  let calls = 0;
  const stop = createEmergencyStop({ store, render: { cancelAll: () => { calls += 1; return { cancelled: [] }; } } });
  const [a, b] = await Promise.all([stop(), stop()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
});

test("MissionService.cancelAll cancels running missions with the reason and leaves paused ones resumable", async (t) => {
  const { store } = await tempStore(t);
  const service = new MissionService({ store, execute: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "cancelled", summary: "aborted" }))) });
  const lane = (id) => ({ id, title: id, repository: "/repo", model: "m", children: [{ id: "a", objective: "work", dependencies: [] }] });
  service.create(lane("running-one"));
  service.create(lane("paused-one"));
  await waitFor(() => service.get("paused-one")?.status === "running");
  service.control("paused-one", "pause");
  const result = service.cancelAll("Cancelled by emergency stop: unit.");
  assert.deepEqual(result, { cancelled: ["running-one"], failed: [] });
  assert.equal(service.get("running-one").status, "cancelled");
  assert.equal(service.get("running-one").reason, "Cancelled by emergency stop: unit.");
  assert.equal(service.get("paused-one").status, "interrupted");
  assert.deepEqual(service.cancelAll(), { cancelled: [], failed: [] });
});

test("AutomationService.halt pauses every automation, stops the schedule timer, and resuming re-arms it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-estop-auto-"));
  const store = new AutomationStore(join(directory, "automations.sqlite"));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const service = new AutomationService({ store, missionService: { create: () => ({ id: "m" }), get: () => null } });
  const timers = new Set();
  service.startScheduler({ intervalMs: 1000, setIntervalImpl: () => { const id = Symbol("timer"); timers.add(id); return id; }, clearIntervalImpl: (id) => timers.delete(id) });
  const action = { kind: "mission", repository: "/repo", model: "m", tasks: ["t"] };
  const one = service.create({ name: "One", trigger: { kind: "schedule", cron: "0 * * * *" }, action }).automation;
  const two = service.create({ name: "Two", trigger: { kind: "manual" }, action }).automation;
  assert.equal(service.schedulerRunning, true);

  const halted = service.halt("Paused by emergency stop: unit.");
  assert.deepEqual(halted.paused.sort(), [one.id, two.id].sort());
  assert.equal(halted.schedulerStopped, true);
  assert.equal(timers.size, 0);
  assert.equal(service.get(one.id).enabled, false);
  assert.equal(service.get(one.id).pausedReason, "Paused by emergency stop: unit.");
  assert.deepEqual(service.halt().paused, [], "idempotent");

  service.resume(one.id);
  assert.equal(service.schedulerRunning, true);
  assert.equal(timers.size, 1);
  assert.equal(service.get(two.id).enabled, false, "only the automation the owner resumed runs again");
});
