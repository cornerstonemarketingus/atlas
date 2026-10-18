import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlatformTaskStore } from "../src/platform/index.mjs";
import { reconcileTaskBudgets } from "../src/platform/budget-reconciliation.mjs";
import {
  ATLAS_TAG, ComputeLeaseStore, ComputeManager, FakeClock, FakeGpuProvider, detectRequirements, microUsdPerSecond,
} from "../src/platform/compute/index.mjs";

const T4_RATE = microUsdPerSecond(0.4); // render jobs (12 GB) land on the 16 GB fake T4
const MINUTE = 60_000;

async function fixture(t, { idleTimeoutSec = 120 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-compute-"));
  const storeFile = join(directory, "platform.sqlite");
  const leaseFile = join(directory, "compute.sqlite");
  const clock = new FakeClock();
  const provider = new FakeGpuProvider({ clock });
  const opened = [];
  const f = {
    clock, provider, storeFile, leaseFile, store: null,
    openStore() { f.store = new PlatformTaskStore(storeFile, { clock: () => new Date(clock.now()) }); opened.push(f.store); return f.store; },
    manager(options = {}) {
      const leases = new ComputeLeaseStore(leaseFile); opened.push(leases);
      return new ComputeManager({ store: f.store, leases, providers: [options.provider ?? provider], clock, idleTimeoutSec, ...options });
    },
    task(budget = { costMicroUsd: 1_000_000 }, parentTaskId = null, tenantId = "owner") {
      return f.store.createTask({ tenantId, userId: "user", objective: "Render a scene on a rented GPU", successCriteria: ["Frames saved"], budget, parentTaskId });
    },
    usage(taskId, tenantId = "owner") { return f.store.getTask(tenantId, taskId).usage.costMicroUsd; },
    releases(taskId) { return f.store.listEvents("owner", { taskId }).filter(e => e.type === "budget.charged" && e.payload.phase === "release"); },
  };
  f.openStore();
  t.after(async () => { for (const handle of opened) { try { handle.close(); } catch { /* already closed */ } } await rm(directory, { recursive: true, force: true }); });
  return f;
}

const renderJob = (id = "job-1", extra = {}) => ({ id, kind: "render", estMinutes: 10, ...extra });

// ---------------------------------------------------------------------------
// Stop 1: budget reservation before provisioning
// ---------------------------------------------------------------------------

test("no provision without an approved cost budget", async t => {
  const f = await fixture(t); const manager = f.manager();
  const task = f.task({ toolCalls: 5 });
  await assert.rejects(manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() }), { code: "NO_APPROVED_BUDGET" });
  assert.equal(f.provider.provisionCount, 0);
  assert.equal(manager.listLeases("owner").length, 0);
});

test("no provision when the estimate exceeds the remaining budget, and nothing is reserved", async t => {
  const f = await fixture(t); const manager = f.manager();
  const task = f.task({ costMicroUsd: T4_RATE * 600 - 1 }); // one micro-dollar short of the 10-minute estimate
  await assert.rejects(manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() }), { code: "ESTIMATE_EXCEEDS_BUDGET" });
  assert.equal(f.provider.provisionCount, 0);
  assert.equal(f.usage(task.id), 0);
});

test("the reservation is visible to siblings: a shared parent allowance admits only one GPU job", async t => {
  const f = await fixture(t); const manager = f.manager();
  const root = f.task({ costMicroUsd: T4_RATE * 900 }); // exactly one 15-minute worst case
  const a = f.task({}, root.id); const b = f.task({}, root.id);
  const first = await manager.start({ tenantId: "owner", taskId: a.id, job: renderJob("job-a") });
  assert.equal(first.lease.reservedMicroUsd, T4_RATE * 900);
  await assert.rejects(manager.start({ tenantId: "owner", taskId: b.id, job: renderJob("job-b") }), { code: "ESTIMATE_EXCEEDS_BUDGET" });
  assert.equal(f.provider.provisionCount, 1);
  await manager.finish("owner", first.lease.id);
});

test("max lifetime shrinks to what the budget covers but never below the estimate", async t => {
  const f = await fixture(t); const manager = f.manager();
  const task = f.task({ costMicroUsd: T4_RATE * 700 });
  const { lease } = await manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  assert.equal(lease.maxLifetimeSec, 700);
  assert.equal(lease.reservedMicroUsd, T4_RATE * 700);
  assert.equal(f.usage(task.id), T4_RATE * 700);
  await manager.finish("owner", lease.id);
});

// ---------------------------------------------------------------------------
// Terminate on success and failure; outputs saved while the instance lives
// ---------------------------------------------------------------------------

test("a successful job saves outputs, terminates its instance and settles the actual cost", async t => {
  const f = await fixture(t); const manager = f.manager();
  const task = f.task();
  let savedWhileRunning = null;
  const result = await manager.runJob({
    tenantId: "owner", taskId: task.id, job: renderJob(),
    execute: async ({ heartbeat }) => { for (let i = 0; i < 4; i++) { f.clock.advance(30_000); assert.equal(heartbeat(), true); } return { frames: 24 }; },
    saveOutputs: async (outputs, { instance }) => { savedWhileRunning = { outputs, state: (await f.provider.status(instance.id)).state }; },
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(savedWhileRunning, { outputs: { frames: 24 }, state: "running" });
  assert.deepEqual(f.provider.running(), []);
  const lease = manager.getLease("owner", result.leaseId);
  assert.equal(lease.state, "settled"); assert.equal(lease.endReason, "job_succeeded");
  assert.equal(lease.actualMicroUsd, T4_RATE * 120);
  assert.equal(lease.releasedMicroUsd, lease.reservedMicroUsd - T4_RATE * 120);
  assert.equal(f.usage(task.id), T4_RATE * 120, "budget usage equals the provider bill after settlement");
  assert.equal(f.releases(task.id).length, 1);
  assert.deepEqual(manager.listAudit("owner", { leaseId: lease.id }).map(e => e.action), ["reserve", "provision", "terminate", "settle"]);
});

test("a failed job terminates its instance, skips outputs and still settles", async t => {
  const f = await fixture(t); const manager = f.manager();
  const task = f.task(); let saved = false;
  const result = await manager.runJob({
    tenantId: "owner", taskId: task.id, job: renderJob(),
    execute: async () => { f.clock.advance(45_000); throw new Error("blender crashed"); },
    saveOutputs: async () => { saved = true; },
  });
  assert.equal(result.status, "failed"); assert.match(result.error.message, /blender crashed/);
  assert.equal(saved, false);
  assert.deepEqual(f.provider.running(), []);
  const lease = manager.getLease("owner", result.leaseId);
  assert.equal(lease.endReason, "job_failed"); assert.equal(lease.state, "settled");
  assert.equal(f.usage(task.id), T4_RATE * 45);
});

test("a failing output callback counts as a failed job and still terminates", async t => {
  const f = await fixture(t); const manager = f.manager(); const task = f.task();
  const result = await manager.runJob({ tenantId: "owner", taskId: task.id, job: renderJob(),
    execute: async () => ({ frames: 1 }), saveOutputs: async () => { throw new Error("disk full"); } });
  assert.equal(result.status, "failed");
  assert.deepEqual(f.provider.running(), []);
});

// ---------------------------------------------------------------------------
// Stop 3: heartbeat-driven idle timeout
// ---------------------------------------------------------------------------

test("a job that stops heartbeating is terminated as idle and told to stop", async t => {
  const f = await fixture(t, { idleTimeoutSec: 120 }); const manager = f.manager();
  const task = f.task();
  const { lease, signal } = await manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  for (let i = 0; i < 3; i++) { f.clock.advance(100_000); assert.equal(manager.heartbeat("owner", lease.id), true); }
  assert.equal((await manager.reconcile()).ended.length, 0, "a heartbeating job is left alone");
  f.clock.advance(119_000);
  assert.equal((await manager.reconcile()).ended.length, 0, "not idle until the timeout passes");
  f.clock.advance(2_000);
  const report = await manager.reconcile();
  assert.deepEqual(report.ended.map(e => e.reason), ["idle"]);
  assert.equal(signal.aborted, true);
  assert.equal(manager.heartbeat("owner", lease.id), false);
  assert.deepEqual(f.provider.running(), []);
  assert.equal(f.usage(task.id), T4_RATE * 421);
});

test("a heartbeat after the idle timeout cannot revive the lease", async t => {
  const f = await fixture(t, { idleTimeoutSec: 60 }); const manager = f.manager();
  const { lease } = await manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob() });
  f.clock.advance(61_000);
  assert.equal(manager.heartbeat("owner", lease.id), false);
  await manager.reconcile();
  assert.deepEqual(f.provider.running(), []);
});

// ---------------------------------------------------------------------------
// Stop 2: max lifetime (provider-side, and manager-side as a second guard)
// ---------------------------------------------------------------------------

test("the provider stops billing at max lifetime even with Atlas gone", async t => {
  const f = await fixture(t, { idleTimeoutSec: 3600 }); let manager = f.manager();
  const task = f.task();
  const { lease } = await manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  manager = null; // Atlas crashes: nobody heartbeats, terminates or reconciles
  f.clock.advance(5 * 3600_000);
  assert.deepEqual(f.provider.running(), [], "the provider terminated it on its own");
  assert.equal(f.provider.totalBilledMicroUsd(), lease.reservedMicroUsd, "billing stopped exactly at the reserved lifetime");
  const restarted = f.manager();
  await restarted.reconcile({ takeover: true });
  const settled = restarted.getLease("owner", lease.id);
  assert.equal(settled.state, "settled"); assert.equal(settled.endReason, "max_lifetime");
  assert.equal(settled.actualMicroUsd, settled.reservedMicroUsd); assert.equal(settled.releasedMicroUsd, 0);
  assert.equal(f.usage(task.id), settled.reservedMicroUsd);
});

test("the manager enforces the deadline itself if a provider ignores max lifetime", async t => {
  const f = await fixture(t, { idleTimeoutSec: 3600 });
  const leaky = new FakeGpuProvider({ clock: f.clock });
  const provision = leaky.provision.bind(leaky);
  leaky.provision = (options) => provision({ ...options, maxLifetimeSec: options.maxLifetimeSec * 100 });
  const manager = f.manager({ provider: leaky });
  const task = f.task();
  const { lease, signal } = await manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  for (let elapsed = 0; elapsed < lease.maxLifetimeSec * 1000; elapsed += 60_000) { f.clock.advance(60_000); manager.heartbeat("owner", lease.id); }
  const report = await manager.reconcile();
  assert.deepEqual(report.ended.map(e => e.reason), ["max_lifetime"]);
  assert.equal(signal.aborted, true);
  assert.deepEqual(leaky.running(), []);
  assert.ok(f.usage(task.id) <= lease.reservedMicroUsd);
});

// ---------------------------------------------------------------------------
// Stop 4: reconciler and crash recovery
// ---------------------------------------------------------------------------

test("chaos: a manager crashing mid-job leaves zero orphans and a settled reservation after restart", async t => {
  const f = await fixture(t, { idleTimeoutSec: 600 });
  let crashed = f.manager();
  const task = f.task();
  const jobs = [];
  for (const id of ["job-a", "job-b"]) {
    let heartbeat;
    const running = crashed.runJob({ tenantId: "owner", taskId: task.id, job: renderJob(id),
      execute: (ctx) => { heartbeat = ctx.heartbeat; return new Promise(() => {}); } }); // never finishes
    jobs.push(running);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof heartbeat, "function");
  }
  f.clock.advance(3 * MINUTE);
  assert.equal(f.provider.running().length, 2);
  // Crash: drop the manager and its process state; keep both databases and the provider.
  crashed = null;
  f.openStore();
  const restarted = f.manager();
  let scheduled = null;
  const first = await restarted.startReconciler({ intervalMs: 30_000, setIntervalImpl: (fn) => { scheduled = fn; return 1; }, clearIntervalImpl: () => { scheduled = null; } });
  assert.equal(first.ended.length, 2);
  assert.deepEqual(f.provider.running(), [], "zero orphan instances");
  for (const lease of restarted.listLeases("owner")) {
    assert.equal(lease.state, "settled"); assert.equal(lease.endReason, "orphaned");
    assert.equal(lease.actualMicroUsd, T4_RATE * 180);
  }
  assert.equal(f.usage(task.id), 2 * T4_RATE * 180, "usage equals what the provider billed");
  assert.equal(f.usage(task.id), f.provider.totalBilledMicroUsd());
  // Re-running the reconciler is a no-op: no double release.
  await restarted.reconcile({ takeover: true });
  assert.equal(f.releases(task.id).length, 2);
  assert.equal(f.usage(task.id), 2 * T4_RATE * 180);
  assert.equal(typeof scheduled, "function"); restarted.stopReconciler(); assert.equal(scheduled, null);
  void jobs;
});

test("chaos: a crash after the provider created the instance but before Atlas recorded it", async t => {
  const f = await fixture(t);
  const crashed = f.manager();
  const provision = f.provider.provision.bind(f.provider);
  f.provider.provision = async (options) => { await provision(options); return new Promise(() => {}); }; // dies before recording
  const task = f.task();
  void crashed.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  await new Promise(resolve => setImmediate(resolve));
  f.provider.provision = provision;
  f.clock.advance(90_000);
  assert.equal(f.provider.running().length, 1);
  const [pending] = crashed.listLeases("owner");
  assert.equal(pending.state, "provisioning"); assert.equal(pending.instanceId, null);
  const restarted = f.manager();
  await restarted.reconcile({ takeover: true });
  assert.deepEqual(f.provider.running(), []);
  const lease = restarted.getLease("owner", pending.id);
  assert.equal(lease.state, "settled"); assert.equal(lease.actualMicroUsd, T4_RATE * 90);
  assert.equal(f.usage(task.id), T4_RATE * 90);
});

test("chaos: a crash during settlement is finished by the next reconcile with exactly one release", async t => {
  const f = await fixture(t);
  const crashed = f.manager(); const task = f.task();
  const { lease } = await crashed.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  f.clock.advance(60_000);
  const recordUsage = f.store.recordUsage.bind(f.store);
  f.store.recordUsage = () => { throw new Error("power cut"); };
  await assert.rejects(crashed.finish("owner", lease.id), /power cut/);
  f.store.recordUsage = recordUsage;
  assert.equal(crashed.getLease("owner", lease.id).state, "settling");
  assert.deepEqual(f.provider.running(), [], "the instance was already terminated");
  f.openStore();
  const restarted = f.manager();
  const report = await restarted.reconcile({ takeover: true });
  assert.deepEqual(report.settled, [lease.id]);
  assert.equal(f.releases(task.id).length, 1);
  assert.equal(f.usage(task.id), T4_RATE * 60);
});

test("chaos: a crash after the budget release but before the lease is marked settled does not release twice", async t => {
  const f = await fixture(t);
  const crashed = f.manager(); const task = f.task();
  const { lease } = await crashed.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  f.clock.advance(600_000); // most of the reservation used, so a second release would undercount the bill
  const update = crashed.leases.update.bind(crashed.leases);
  crashed.leases.update = (tenantId, id, from, fields) => { if (fields.state === "settled") throw new Error("power cut"); return update(tenantId, id, from, fields); };
  await assert.rejects(crashed.finish("owner", lease.id), /power cut/);
  assert.equal(f.releases(task.id).length, 1);
  f.openStore();
  const restarted = f.manager();
  await restarted.reconcile({ takeover: true });
  assert.equal(restarted.getLease("owner", lease.id).state, "settled");
  assert.equal(f.releases(task.id).length, 1);
  assert.equal(f.usage(task.id), T4_RATE * 600);
});

test("the reconciler terminates tagged instances with no lease at all, and leaves untagged ones alone", async t => {
  const f = await fixture(t); const manager = f.manager();
  const stray = await f.provider.provision({ gpuType: "fake-t4-16gb", maxLifetimeSec: 3600, tags: [ATLAS_TAG, "atlas-tenant:owner", "atlas-lease:lost"] });
  const foreign = await f.provider.provision({ gpuType: "fake-t4-16gb", maxLifetimeSec: 3600, tags: ["someone-else"] });
  const live = await manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob() });
  const report = await manager.reconcile();
  assert.deepEqual(report.orphansTerminated.map(o => o.instanceId), [stray.id]);
  assert.deepEqual(f.provider.running().map(i => i.id).sort(), [foreign.id, live.instance.id].sort());
  assert.equal(manager.listAudit("owner").find(e => e.details.instanceId === stray.id).details.unattributed, true);
  await manager.finish("owner", live.lease.id);
});

test("without takeover a second live manager's leases are respected; with takeover they are ended", async t => {
  const f = await fixture(t);
  const a = f.manager(); const b = f.manager();
  const { lease } = await a.start({ tenantId: "owner", taskId: f.task().id, job: renderJob() });
  assert.equal((await b.reconcile()).ended.length, 0);
  assert.equal(f.provider.running().length, 1);
  assert.equal((await b.reconcile({ takeover: true })).ended.length, 1);
  assert.equal(b.getLease("owner", lease.id).state, "settled");
  assert.deepEqual(f.provider.running(), []);
});

test("a terminate failure keeps the lease pending; the reconciler retries until the instance is gone", async t => {
  const f = await fixture(t); const manager = f.manager(); const task = f.task();
  const { lease } = await manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  f.clock.advance(30_000);
  f.provider.failTerminate = true;
  const result = await manager.finish("owner", lease.id);
  assert.equal(result.settled, false);
  assert.equal(manager.getLease("owner", lease.id).state, "terminating");
  assert.equal(manager.heartbeat("owner", lease.id), false, "a lease being terminated is never live again");
  assert.equal((await manager.reconcile()).errors.length > 0, true);
  f.provider.failTerminate = false;
  f.clock.advance(30_000);
  await manager.reconcile();
  assert.equal(manager.getLease("owner", lease.id).state, "settled");
  assert.deepEqual(f.provider.running(), []);
  assert.equal(f.usage(task.id), T4_RATE * 60);
});

test("a failed provision releases the whole reservation and audits no secrets", async t => {
  const f = await fixture(t); const manager = f.manager(); const task = f.task();
  f.provider.provision = async () => { const error = new Error("auth failed for key sk-live-SUPERSECRET123"); error.code = "AUTH"; throw error; };
  await assert.rejects(manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() }), { code: "PROVISION_FAILED" });
  const [lease] = manager.listLeases("owner");
  assert.equal(lease.state, "settled"); assert.equal(lease.actualMicroUsd, 0);
  assert.equal(f.usage(task.id), 0);
  assert.doesNotMatch(manager.leases.dumpText(), /SUPERSECRET/);
  assert.doesNotMatch(JSON.stringify(f.store.listEvents("owner")), /SUPERSECRET/);
});

// ---------------------------------------------------------------------------
// Cost never exceeds the reservation
// ---------------------------------------------------------------------------

test("property: across random jobs, crashes and timeouts the bill never exceeds the reservation", async t => {
  const f = await fixture(t, { idleTimeoutSec: 90 });
  let seed = 353; const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const root = f.task({ costMicroUsd: 50_000_000 });
  let manager = f.manager();
  for (let i = 0; i < 40; i++) {
    const task = f.task({}, root.id);
    const job = { id: `job-${i}`, kind: random() < 0.5 ? "render" : "training", estMinutes: 1 + Math.floor(random() * 20), ...(random() < 0.3 ? { maxMinutes: 5 } : {}) };
    const { lease } = await manager.start({ tenantId: "owner", taskId: task.id, job });
    const runFor = Math.floor(random() * lease.maxLifetimeSec * 1.5 * 1000);
    for (let elapsed = 0; elapsed < runFor; elapsed += 60_000) { f.clock.advance(Math.min(60_000, runFor - elapsed)); if (random() < 0.9) manager.heartbeat("owner", lease.id); }
    const ending = random();
    if (ending < 0.4) await manager.finish("owner", lease.id, { outcome: random() < 0.5 ? "succeeded" : "failed" });
    else if (ending < 0.7) await manager.reconcile();
    else { manager = f.manager(); await manager.reconcile({ takeover: true }); } // crash and restart
  }
  f.clock.advance(10 * 3600_000);
  await manager.reconcile({ takeover: true });
  assert.deepEqual(f.provider.running(), []);
  let reserved = 0; let actual = 0;
  for (const lease of manager.listLeases("owner")) {
    assert.equal(lease.state, "settled");
    assert.ok(Number.isInteger(lease.actualMicroUsd) && lease.actualMicroUsd <= lease.reservedMicroUsd, `lease ${lease.jobId} billed ${lease.actualMicroUsd} > reserved ${lease.reservedMicroUsd}`);
    assert.equal(lease.excessMicroUsd, 0);
    reserved += lease.reservedMicroUsd; actual += lease.actualMicroUsd;
  }
  assert.equal(actual, f.provider.totalBilledMicroUsd());
  assert.ok(actual <= reserved);
  assert.equal(f.usage(root.id), actual, "the parent budget carries exactly the real bill");
  assert.deepEqual(reconcileTaskBudgets({ store: f.store, tenantId: "owner" }).updates, [], "budget reconciliation agrees: releases are accounted for");
});

// ---------------------------------------------------------------------------
// Requirement detection, tenancy
// ---------------------------------------------------------------------------

test("requirement detection picks a VRAM floor, prefers a capable local GPU and refuses impossible jobs", async t => {
  assert.equal(detectRequirements({ id: "r", kind: "render" }).minVramGb, 12);
  assert.equal(detectRequirements({ id: "i", kind: "inference", modelParamsB: 13 }).minVramGb, 32);
  assert.equal(detectRequirements({ id: "v", kind: "render", vramGb: 40 }).minVramGb, 40);
  assert.equal(detectRequirements({ id: "x", kind: "transcode" }).runLocally, true);
  assert.equal(detectRequirements({ id: "l", kind: "render" }, { localHardware: { gpus: [{ vendor: "nvidia", memoryGiB: 24 }] } }).runLocally, true);
  assert.equal(detectRequirements({ id: "l", kind: "training" }, { localHardware: { gpus: [{ vendor: "nvidia", memoryGiB: 8 }] } }).runLocally, false);
  assert.throws(() => detectRequirements({ id: "q", kind: "mining" }), { code: "UNKNOWN_JOB_KIND" });

  const f = await fixture(t);
  const local = f.manager({ localHardware: { gpus: [{ vendor: "nvidia", memoryGiB: 24 }] } });
  const task = f.task();
  assert.equal((await local.runJob({ tenantId: "owner", taskId: task.id, job: renderJob(), execute: async () => assert.fail("must not rent") })).status, "local");
  const manager = f.manager();
  await assert.rejects(manager.start({ tenantId: "owner", taskId: task.id, job: { id: "huge", kind: "inference", modelParamsB: 70 } }), { code: "NO_GPU_AVAILABLE" });
  const { lease } = await manager.start({ tenantId: "owner", taskId: task.id, job: { id: "big", kind: "inference", modelParamsB: 13 } });
  assert.equal(lease.gpuType, "fake-a100-80gb");
  assert.equal(f.provider.provisionCount, 1);
  await manager.finish("owner", lease.id);
});

test("leases and audit are tenant-scoped", async t => {
  const f = await fixture(t); const manager = f.manager();
  const { lease } = await manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob() });
  assert.equal(manager.getLease("intruder", lease.id), null);
  assert.deepEqual(manager.listLeases("intruder"), []);
  assert.deepEqual(manager.listAudit("intruder"), []);
  await assert.rejects(manager.start({ tenantId: "intruder", taskId: lease.taskId, job: renderJob("job-x") }), /does not exist in this tenant/);
  await manager.finish("owner", lease.id);
});
