import { Worker } from "node:worker_threads";
import { defineTool } from "../../../packages/atlas-contracts/src/index.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformTaskStore, TaskBudget, TaskBudgetExceededError, AuthorizedToolExecutor, PolicyEngine } from "../src/platform/index.mjs";
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-parent-budget-")); const filename = join(directory, "tasks.sqlite"); let store = new PlatformTaskStore(filename);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { filename, get store() { return store; }, reopen() { store.close(); store = new PlatformTaskStore(filename); },
    task(budget = {}, parentTaskId = null) { return store.createTask({ tenantId: "owner", userId: "user", objective: "Run a bounded delegated task", successCriteria: ["Verified result"], budget, parentTaskId }); },
    budget(task) { return new TaskBudget({ store, tenantId: "owner", taskId: task.id }); } };
}
test("siblings share a parent allowance and reopening does not reset it", async t => {
  const f = await fixture(t); const root = f.task({ toolCalls: 2 }); const a = f.task({ toolCalls: 10 }, root.id); const b = f.task({ toolCalls: 10 }, root.id);
  f.budget(a).reserve(); f.budget(b).reserve(); f.reopen();
  assert.equal(f.store.getTask("owner", root.id).usage.toolCalls, 2);
  assert.equal(f.budget(a).remaining("toolCalls"), 0);
  assert.throws(() => f.budget(b).reserve(), TaskBudgetExceededError);
  assert.equal(f.store.getTask("owner", b.id).usage.toolCalls, 1);
});
test("actual cost and tokens propagate through all ancestors without hiding overruns", async t => {
  const f = await fixture(t); const root = f.task({ costMicroUsd: 10 }); const middle = f.task({}, root.id); const leaf = f.task({}, middle.id);
  f.budget(leaf).charge({ costMicroUsd: 12, inputTokens: 5 });
  for (const task of [root, middle, leaf]) { const usage = f.store.getTask("owner", task.id).usage; assert.equal(usage.costMicroUsd, 12); assert.equal(usage.inputTokens, 5); }
  assert.throws(() => f.budget(leaf).reserve(), TaskBudgetExceededError);
  assert.ok(f.store.listEvents("owner", { taskId: root.id }).some(event => event.type === "budget.exceeded"));
});
test("a parent usage write failure rolls back the child usage and audit events", async t => {
  const f = await fixture(t); const root = f.task({ toolCalls: 3 }); const child = f.task({}, root.id);
  const record = f.store.recordUsage.bind(f.store); const before = f.store.listEvents("owner").length;
  f.store.recordUsage = (tenant, id, usage) => { if (id === root.id) throw Error("parent write unavailable"); return record(tenant, id, usage); };
  assert.throws(() => f.budget(child).reserve(), /parent write unavailable/);
  assert.equal(f.store.getTask("owner", child.id).usage.toolCalls, 0);
  assert.equal(f.store.listEvents("owner").length, before);
});
test("the real executor blocks a sibling before its tool runs when the shared allowance is spent", async t => {
  const f = await fixture(t); const root = f.task({ toolCalls: 1 }); const first = f.task({}, root.id); const second = f.task({}, root.id);
  for (const task of [first, second]) for (const to of ["authorized", "queued", "running"]) f.store.transitionTask("owner", task.id, to, { actor: "test" });
  let calls = 0; const executor = new AuthorizedToolExecutor({ store: f.store, policy: new PolicyEngine({ version: "test", rules: [] }) });
  executor.register(defineTool({ name: "demo.work", description: "Bounded test work", risk: "read", inputSchema: { type: "object", additionalProperties: false, properties: {} }, execute: async () => { calls++; return { output: "verified" }; } }));
  const invoke = task => executor.invoke({ tenantId: "owner", userId: "user", taskId: task.id, tool: "demo.work", input: {}, grantedPermissions: ["demo.*"] });
  assert.equal((await invoke(first)).status, "succeeded");
  const refused = await invoke(second); assert.equal(refused.result.error.code, "BUDGET_EXCEEDED"); assert.equal(calls, 1);
});


test("independent SQLite workers cannot overrun a shared parent reservation", async t => {
  const f = await fixture(t); const root = f.task({ toolCalls: 3 });
  const children = Array.from({ length: 8 }, () => f.task({}, root.id));
  const moduleUrl = new URL("../src/platform/index.mjs", import.meta.url).href;
  const results = await Promise.all(children.map(task => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => { const { PlatformTaskStore, TaskBudget } = await import(workerData.moduleUrl);
        const store = new PlatformTaskStore(workerData.filename);
        try { new TaskBudget({ store, tenantId: "owner", taskId: workerData.taskId }).reserve(); parentPort.postMessage("reserved"); }
        catch (error) { parentPort.postMessage(error.code ?? error.message); }
        finally { store.close(); }
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { moduleUrl, filename: f.filename, taskId: task.id } });
    let result; worker.once("message", value => { result = value; }); worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve(result) : reject(new Error(`Budget worker exited ${code}`)));
  })));
  assert.equal(results.filter(result => result === "reserved").length, 3);
  assert.equal(results.filter(result => result === "BUDGET_EXCEEDED").length, 5);
  assert.equal(f.store.getTask("owner", root.id).usage.toolCalls, 3);
});

test("a cyclic parent chain fails before any usage mutation", async t => {
  const f = await fixture(t); const root = f.task({ toolCalls: 3 }); const child = f.task({}, root.id);
  const get = f.store.getTask.bind(f.store);
  f.store.getTask = (tenant, id) => { const task = get(tenant, id); return task?.id === root.id ? { ...task, parentTaskId: child.id } : task; };
  assert.throws(() => f.budget(child).reserve(), /cyclic/);
  assert.equal(get("owner", child.id).usage.toolCalls, 0);
  assert.equal(get("owner", root.id).usage.toolCalls, 0);
});
