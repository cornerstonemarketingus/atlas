import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { BusinessService } from "../src/agent/business-service.mjs";
import { BUDGET_DIMENSIONS } from "../src/agent/budget.mjs";
import { MissionService } from "../src/agent/mission-service.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const amounts = value => Object.fromEntries(BUDGET_DIMENSIONS.map(key => [key, value]));
const launch = { repository: "C:/work/business", model: "local" };
async function fixture(t, missions = { get: () => null, create: request => request }) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-business-budget-"));
  const filename = join(directory, "business.sqlite");
  const service = new BusinessService({ filename, missionService: missions });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, filename };
}

test("repeated launches reserve cumulative bounds and never label allocations actual spending", async t => {
  const saved = new Map();
  const { service } = await fixture(t, {
    get: id => saved.get(id),
    create: request => { saved.set(request.id, { ...request, status: "completed", children: request.children.map(child => ({ ...child, usage: amounts(1) })) }); return request; },
  });
  const business = service.create({ name: "Builder", objective: "Prepare", budget: amounts(100) });
  assert.throws(() => service.launch(business.id, { model: "local" }), /repository/);
  assert.equal(service.get(business.id).executionBudget.reservations, 0);
  service.launch(business.id, { ...launch, budget: amounts(40) });
  service.launch(business.id, { ...launch, budget: amounts(40) });
  const accounting = service.get(business.id).executionBudget;
  assert.deepEqual(accounting.reserved, amounts(80));
  assert.deepEqual(accounting.observedUsage, amounts(10));
  assert.deepEqual(accounting.remaining, amounts(20));
  assert.throws(() => service.launch(business.id, { ...launch, budget: amounts(21) }), { code: "BUDGET_EXCEEDED" });
  assert.equal(saved.size, 2);
  // Completed missions remain retryable: their entire allowance stays held.
  assert.equal(service.get(business.id).executionBudget.reservations, 2);
});

test("lost create acknowledgements keep durable uncertain reservations across restart", async t => {
  let calls = 0;
  const { service, filename } = await fixture(t, { get: () => null, create: () => { calls++; throw new Error("lost acknowledgement"); } });
  const business = service.create({ name: "Builder", objective: "Prepare", budget: amounts(100) });
  assert.throws(() => service.launch(business.id, launch), /lost acknowledgement/);
  const reopened = new BusinessService({ filename, missionService: { get: () => null, create: () => assert.fail("must not execute") } });
  try {
    const state = reopened.get(business.id).executionBudget;
    assert.deepEqual(state.reserved, amounts(100));
    assert.equal(state.uncertainMissions, 1);
    assert.throws(() => reopened.launch(business.id, launch), { code: "BUDGET_EXCEEDED" });
    assert.equal(calls, 1);
  } finally { reopened.close(); }
});

test("separate worker connections race at real BusinessService admission without overcommit", async t => {
  const { service, filename } = await fixture(t);
  const business = service.create({ name: "Builder", objective: "Prepare", budget: amounts(100) });
  const workerSource = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { BusinessService } = await import(workerData.module);
      const service = new BusinessService({filename: workerData.filename, missionService: { get: () => null, create: value => value }});
      parentPort.postMessage('ready');
      parentPort.once('message', () => {
        try { service.launch(workerData.id, workerData.launch); parentPort.postMessage('admitted'); }
        catch(error) { parentPort.postMessage(error.code ?? error.message); }
        finally { service.close(); }
      });
    })().catch(error => { throw error; });`;
  const workers = Array.from({ length: 4 }, () => new Worker(workerSource, { eval: true, workerData: { module: new URL("../src/agent/business-service.mjs", import.meta.url).href, filename, id: business.id, launch: { ...launch, budget: amounts(60) } } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); })));
  const results = workers.map(worker => new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); }));
  workers.forEach(worker => worker.postMessage("go"));
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(value => value === "admitted").length, 1);
  assert.equal(outcomes.filter(value => value === "BUDGET_EXCEEDED").length, 3);
  assert.deepEqual(service.get(business.id).executionBudget.reserved, amounts(60));
});

test("legacy businesses surface unknown history and fail closed; new explicit budgets are actionable", async t => {
  const { service, filename } = await fixture(t);
  const db = new DatabaseSync(filename);
  db.prepare("INSERT INTO businesses VALUES (?,?)").run("legacy", JSON.stringify({ id: "legacy", name: "Old", objective: "Prepare", budget: amounts(100) }));
  db.close();
  assert.equal(service.get("legacy").executionBudget.historyUncertain, true);
  assert.throws(() => service.launch("legacy", launch), { code: "BUSINESS_BUDGET_HISTORY_UNCERTAIN" });
  const replacement = service.create({ name: "Explicit new authorization", objective: "New preparation", budget: amounts(100) });
  assert.ok(service.launch(replacement.id, launch).id);
  assert.throws(() => service.create({ name: "Unsafe", objective: "Prepare", budget: { costMicroUsd: Number.MAX_VALUE } }), /safe integers/);
});

test("real durable mission usage survives both store and business connection restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-business-real-budget-"));
  const filename = join(directory, "business.sqlite");
  const storeFile = join(directory, "missions.sqlite");
  let store = new LocalTaskStore(storeFile);
  const execute = async ({ child }) => ({ usage: { costMicroUsd: 2 }, evidence: [{ kind: "patch", path: `/patches/${child.id}`, bytes: 10 }] });
  let missions = new MissionService({ store, execute });
  let service = new BusinessService({ filename, missionService: missions });
  t.after(async () => { service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const business = service.create({ name: "Durable", objective: "Prepare", budget: { costMicroUsd: 100, elapsedMs: 100000 } });
  const mission = service.launch(business.id, launch);
  for (let count = 0; missions.get(mission.id).status !== "completed" && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(missions.get(mission.id).status, "completed");
  assert.equal(service.get(business.id).executionBudget.observedUsage.costMicroUsd, 10);
  service.close(); store.close();
  store = new LocalTaskStore(storeFile);
  missions = new MissionService({ store, execute });
  service = new BusinessService({ filename, missionService: missions });
  const state = service.get(business.id).executionBudget;
  assert.equal(state.observedUsage.costMicroUsd, 10);
  assert.equal(state.reserved.costMicroUsd, 100);
  assert.equal(state.uncertainMissions, 0);
  assert.throws(() => service.launch(business.id, launch), { code: "BUDGET_EXCEEDED" });
});

test("bounded reservation history refuses new execution instead of truncating accounting", async t => {
  const { service, filename } = await fixture(t);
  const business = service.create({ name: "Bounded", objective: "Prepare", budget: amounts(100) });
  const db = new DatabaseSync(filename);
  db.exec("BEGIN IMMEDIATE");
  const insert = db.prepare("INSERT INTO business_budget_reservations VALUES (?,?,?,?,?)");
  for (let index = 0; index < 1000; index++) insert.run(`mission-${index}`, business.id, JSON.stringify(amounts(0)), "launch-uncertain", "2026-10-17");
  db.exec("COMMIT"); db.close();
  assert.equal(service.get(business.id).executionBudget.reservations, 1000);
  assert.throws(() => service.launch(business.id, launch), { code: "BUSINESS_BUDGET_LEDGER_FULL" });
});
