import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlatformTaskStore, TaskBudget } from "../src/platform/index.mjs";
import { reconcileTaskBudgets } from "../src/platform/budget-reconciliation.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-budget-release-"));
  const store = new PlatformTaskStore(join(directory, "tasks.sqlite"));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const task = (budget = {}, parentTaskId = null) => store.createTask({ tenantId: "owner", userId: "user", objective: "Settle a reservation", successCriteria: ["Settled"], budget, parentTaskId });
  return { store, task, budget: (t) => new TaskBudget({ store, tenantId: "owner", taskId: t.id }) };
}

test("release returns an unused reservation at every scope and is recorded once by ref", async t => {
  const f = await fixture(t); const root = f.task({ costMicroUsd: 100 }); const child = f.task({}, root.id);
  f.budget(child).reserve({ costMicroUsd: 80 });
  assert.equal(f.budget(child).remaining("costMicroUsd"), 20);
  f.budget(child).release({ costMicroUsd: 50 }, { ref: "lease-1" });
  assert.equal(f.store.getTask("owner", root.id).usage.costMicroUsd, 30);
  assert.equal(f.store.getTask("owner", child.id).usage.costMicroUsd, 30);
  assert.equal(f.budget(child).hasRelease("lease-1"), true);
  assert.equal(f.budget(child).hasRelease("lease-2"), false);
  assert.deepEqual(reconcileTaskBudgets({ store: f.store, tenantId: "owner" }).updates, []);
});

test("release cannot create allowance, needs a ref, and writes nothing when refused", async t => {
  const f = await fixture(t); const root = f.task({ costMicroUsd: 100 }); const child = f.task({}, root.id);
  f.budget(child).reserve({ costMicroUsd: 10 });
  const before = f.store.listEvents("owner").length;
  assert.throws(() => f.budget(child).release({ costMicroUsd: 11 }, { ref: "x" }), /exceeds recorded usage/);
  assert.throws(() => f.budget(child).release({ costMicroUsd: 1 }), /settlement ref/);
  assert.equal(f.store.getTask("owner", root.id).usage.costMicroUsd, 10);
  assert.equal(f.store.listEvents("owner").length, before);
});

test("budget reconciliation still credits missing history correctly alongside releases", async t => {
  const f = await fixture(t); const root = f.task({ costMicroUsd: 1000 }); const child = f.task({}, root.id);
  f.budget(child).reserve({ costMicroUsd: 100 });
  f.budget(child).release({ costMicroUsd: 40 }, { ref: "lease-1" });
  // Direct usage recorded on the child without crediting the parent (pre-cumulative history).
  f.store.recordUsage("owner", child.id, { ...f.store.getTask("owner", child.id).usage, costMicroUsd: 75 });
  const { updates } = reconcileTaskBudgets({ store: f.store, tenantId: "owner" });
  assert.deepEqual(updates.map(u => u.amounts.costMicroUsd), [15]);
});
