import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { BusinessBudget } from "../src/agent/business-budget.mjs";
import { BusinessService } from "../src/agent/business-service.mjs";
import { BUDGET_DIMENSIONS } from "../src/agent/budget.mjs";
import { MissionService } from "../src/agent/mission-service.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { AutomationService, AutomationStore, normalizeAutomation } from "../src/platform/automations/service.mjs";
import { createLocalControlServer } from "../src/server.mjs";

const amounts = value => Object.fromEntries(BUDGET_DIMENSIONS.map(key => [key, value]));
const execution = { repository: "C:/review", model: "local", budget: amounts(1000) };
async function drain(missions) {
  for (let count = 0; missions.list().some(mission => ["running", "queued"].includes(mission.status)) && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(missions.list().every(mission => !["running", "queued"].includes(mission.status)));
}
async function fixture(t, { execute, failCreate = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-business-review-"));
  const tasks = new LocalTaskStore(join(directory, "tasks.sqlite"));
  let calls = 0;
  let now = Date.now();
  const missions = new MissionService({ store: tasks, execute: execute ?? (async () => {
    calls++;
    return { evidence: [{ kind: "patch", path: "/patches/review", bytes: 10 }] };
  }) });
  const filename = join(directory, "business.sqlite");
  const businesses = new BusinessService({ filename, clock: () => now, missionService: failCreate ? { get: id => missions.get(id), create: () => { calls++; throw new Error("lost start acknowledgement"); } } : missions });
  const automationFilename = join(directory, "automations.sqlite");
  const store = new AutomationStore(automationFilename);
  const automations = new AutomationService({ store, missionService: missions, businessService: businesses, clock: () => now });
  const business = businesses.create({ name: "Builder", objective: "Prepare lead review", budget: amounts(10000) });
  const responsibility = businesses.assign(business.id, { owner: "owner", objective: "Review inquiry workflow", successCriteria: ["Document failure handling"], intervalMs: 60000 });
  const action = { kind: "business-review", businessId: business.id, responsibilityId: responsibility.id, ...execution };
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); await drain(missions); store.close(); businesses.close(); tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, tasks, missions, businesses, store, automations, business, responsibility, action, filename, automationFilename, cleanups, calls: () => calls, advance: ms => { now += ms; } };
}

test("owner business review action requires exact IDs and explicit complete execution bounds", () => {
  const action = { kind: "business-review", businessId: "business", responsibilityId: "responsibility", ...execution };
  const definition = { name: "Review", trigger: { kind: "schedule", cron: "* * * * *" }, action };
  assert.equal(normalizeAutomation(definition).action.kind, "business-review");
  for (const invalid of [{ ...action, budget: {} }, { ...action, budget: { ...execution.budget, bogus: 1 } }, { ...action, businessId: "../other" }, { ...action, role: "admin" }]) {
    assert.throws(() => normalizeAutomation({ ...definition, action: invalid }));
  }
});

test("two automations and manual triggers dispatch each exact due cycle once through real mission and budget stores", async t => {
  const f = await fixture(t);
  const first = f.automations.create({ name: "Review", trigger: { kind: "manual" }, action: f.action }).automation;
  const second = f.automations.create({ name: "Another review", trigger: { kind: "manual" }, action: f.action }).automation;
  const results = await Promise.all([f.automations.runNow(first.id), f.automations.runNow(second.id)]);
  assert.equal(results.filter(run => run.status === "running").length, 1);
  assert.equal(results.filter(run => run.status === "skipped").length, 1);
  await drain(f.missions);
  await f.automations.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.missions.list().length, 1);
  const mission = f.missions.get(results.find(run => run.missionId).missionId);
  assert.equal(mission.children[0].metadata.responsibilityId, f.responsibility.id);
  assert.match(mission.children[0].objective, /Document failure handling/);
  assert.deepEqual(f.businesses.get(f.business.id).executionBudget.reserved, execution.budget);
  assert.equal(f.businesses.get(f.business.id).responsibilities[0].lastReview, null);
  assert.equal((await f.automations.runNow(first.id)).status, "skipped");
  f.businesses.review(f.business.id, f.responsibility.id, { missionId: mission.id });
  assert.equal((await f.automations.runNow(first.id)).status, "skipped", "owner review advances due date; never immediately repeat");
});

test("lost mission creation acknowledgement holds the cycle and allowance across reopened services", async t => {
  const f = await fixture(t, { failCreate: true });
  assert.throws(() => f.businesses.dispatchReview(f.business.id, f.responsibility.id, execution), /lost start/);
  const reopened = new BusinessService({ filename: f.filename, missionService: { get: () => null, create: () => assert.fail("uncertain cycle must not replay") } });
  try {
    assert.throws(() => reopened.dispatchReview(f.business.id, f.responsibility.id, execution), { code: "BUSINESS_REVIEW_UNCERTAIN" });
    assert.deepEqual(reopened.get(f.business.id).executionBudget.reserved, execution.budget);
  } finally { reopened.close(); }
  assert.equal(f.calls(), 1);
});

test("business allowance exhaustion prevents executor start and does not consume a due cycle", async t => {
  const f = await fixture(t);
  assert.throws(() => f.businesses.dispatchReview(f.business.id, f.responsibility.id, { ...execution, budget: amounts(10001) }), { code: "BUDGET_EXCEEDED" });
  assert.equal(f.calls(), 0);
  const started = f.businesses.dispatchReview(f.business.id, f.responsibility.id, execution);
  assert.equal(started.status, "started");
  await drain(f.missions);
});

test("schedule recurrence waits for owner review and a new due cycle; known dispatch survives reopening", async t => {
  const f = await fixture(t);
  const auto = f.automations.create({ name: "Recurring review", trigger: { kind: "schedule", cron: "* * * * *" }, action: f.action }).automation;
  f.advance(60000);
  const [run] = await f.automations.tick();
  assert.equal(run.status, "running");
  await drain(f.missions);
  const reopened = new BusinessService({ filename: f.filename, missionService: f.missions });
  try { assert.equal(reopened.dispatchReview(f.business.id, f.responsibility.id, execution).status, "already-dispatched"); }
  finally { reopened.close(); }
  f.advance(60000);
  assert.equal((await f.automations.tick())[0].status, "skipped");
  assert.equal(f.calls(), 1);
  f.businesses.review(f.business.id, f.responsibility.id, { missionId: run.missionId });
  f.advance(60000);
  assert.equal((await f.automations.tick())[0].status, "running");
  await drain(f.missions);
  assert.equal(f.calls(), 2);
  assert.deepEqual(f.businesses.get(f.business.id).executionBudget.reserved, amounts(2000));
  assert.equal(f.automations.get(auto.id).runs.length, 3);
});

test("separate worker connections claim one due-cycle reservation before any executor", async t => {
  const f = await fixture(t);
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { BusinessService } = await import(workerData.module);
      let starts = 0;
      const service = new BusinessService({ filename: workerData.filename, missionService: { get: () => null, create: request => { starts++; return request; } } });
      try { const result = service.dispatchReview(workerData.businessId, workerData.responsibilityId, workerData.execution); parentPort.postMessage({ starts, status: result.status }); }
      catch(error) { parentPort.postMessage({ starts, code: error.code }); }
      finally { service.close(); }
    })();`;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { module: new URL("../src/agent/business-service.mjs", import.meta.url).href, filename: f.filename, businessId: f.business.id, responsibilityId: f.responsibility.id, execution } });
    worker.once("message", resolve); worker.once("error", reject);
  })));
  assert.equal(results.reduce((sum, result) => sum + result.starts, 0), 1);
  assert.equal(results.filter(result => result.status === "started").length, 1);
  assert.equal(results.filter(result => result.code === "BUSINESS_REVIEW_UNCERTAIN").length, 3);
  assert.deepEqual(f.businesses.get(f.business.id).executionBudget.reserved, execution.budget);
});

test("owner review advancing the cycle between initial read and reservation prevents stale execution", async t => {
  const f = await fixture(t);
  const original = BusinessBudget.prototype.reserve;
  BusinessBudget.prototype.reserve = function (...args) {
    if (args[3]) {
      const other = new DatabaseSync(f.filename);
      try {
        const current = JSON.parse(other.prepare("SELECT record FROM business_responsibilities WHERE id=?").get(f.responsibility.id).record);
        current.nextReviewAt = new Date(Date.now() + 60000).toISOString();
        other.prepare("UPDATE business_responsibilities SET record=? WHERE id=?").run(JSON.stringify(current), current.id);
      } finally { other.close(); }
    }
    return original.apply(this, args);
  };
  try {
    assert.equal(f.businesses.dispatchReview(f.business.id, f.responsibility.id, execution).status, "not-due");
    assert.equal(f.calls(), 0);
    assert.equal(f.businesses.get(f.business.id).executionBudget.reservations, 0);
  } finally { BusinessBudget.prototype.reserve = original; }
});

test("business review automation configuration remains owner-only at HTTP boundary", async t => {
  const f = await fixture(t);
  const token = "0123456789abcdef0123456789abcdef";
  const server = createLocalControlServer({ store: f.tasks, token, automations: f.automations, businessService: f.businesses, runTask: async () => ({ ok: true }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.cleanups.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers })).json();
  const { deviceToken } = await (await fetch(`${origin}/v1/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Phone" }) })).json();
  const body = JSON.stringify({ name: "Review", trigger: { kind: "schedule", cron: "* * * * *" }, action: f.action });
  assert.equal((await fetch(`${origin}/v1/automations`, { method: "POST", headers: { ...headers, authorization: `Bearer ${deviceToken}` }, body })).status, 403);
  assert.equal((await fetch(`${origin}/v1/automations`, { method: "POST", headers, body })).status, 201);
  assert.equal(f.calls(), 0, "configuration alone does not fire work");
});
