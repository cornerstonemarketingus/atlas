import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlatformTaskStore } from "../src/platform/index.mjs";
import { ArtifactStore } from "../src/platform/artifacts/index.mjs";
import { reconcileTaskBudgets } from "../src/platform/budget-reconciliation.mjs";
import {
  ATLAS_TAG, ComputeLeaseStore, ComputeManager, FakeClock, RUNPOD_DEFAULT_PRICING, RunpodProvider, createComputeService,
  microUsdPerSecond, parseMonthlyCapUsd, resolveRunpodPricing,
} from "../src/platform/compute/index.mjs";
import { startFakeRunpod } from "./helpers/fake-runpod-server.mjs";

// Everything here talks to a loopback fake of the RunPod API; nothing reaches the network or spends money.
const API_KEY = "rpa_TESTKEY_DO_NOT_LEAK_7f3c9e";
const RATE = microUsdPerSecond(0.68); // AMPERE_24, the default pool
const IDLE_SEC = 5; const COLD_SEC = 25; const OVERHEAD_SEC = IDLE_SEC + COLD_SEC;
const QUEUE_TTL_SEC = 900;
const MINUTE = 60_000;
const BIG_CAP = 1_000_000_000;
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function fixture(t, { idleTimeoutSec = 600, monthlyCapMicroUsd = BIG_CAP } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-runpod-"));
  const storeFile = join(directory, "platform.sqlite");
  const leaseFile = join(directory, "compute.sqlite");
  const clock = new FakeClock(Date.UTC(2026, 9, 10));
  const server = await startFakeRunpod({ clock, apiKey: API_KEY, coldStartMs: COLD_SEC * 1000, idleMs: IDLE_SEC * 1000 });
  const opened = [];
  const f = {
    clock, server, directory, leaseFile, store: null,
    openStore() { f.store = new PlatformTaskStore(storeFile, { clock: () => new Date(clock.now()) }); opened.push(f.store); return f.store; },
    /** A fresh adapter over the same journal file, as a restarted daemon would build it. */
    provider(options = {}) {
      return new RunpodProvider({ endpointId: server.endpointId, apiKey: API_KEY, baseUrl: server.baseUrl, db: leaseFile, clock,
        workerIdleTimeoutSec: IDLE_SEC, coldStartAllowanceSec: COLD_SEC, queueTtlSec: QUEUE_TTL_SEC, requestTimeoutMs: 2_000, ...options });
    },
    manager(options = {}) {
      const leases = new ComputeLeaseStore(leaseFile); opened.push(leases);
      const provider = options.provider ?? f.provider();
      return Object.assign(new ComputeManager({ store: f.store, leases, providers: [provider], clock, idleTimeoutSec, monthlyCapMicroUsd, ...options }), { provider });
    },
    task(budget = { costMicroUsd: 5_000_000 }, tenantId = "owner") {
      return f.store.createTask({ tenantId, userId: "user", objective: "Render frames on RunPod", successCriteria: ["Frames saved"], budget });
    },
    usage(taskId, tenantId = "owner") { return f.store.getTask(tenantId, taskId).usage.costMicroUsd; },
  };
  f.openStore();
  t.after(async () => {
    await server.close();
    for (const handle of opened) { try { handle.close(); } catch { /* already closed */ } }
    await rm(directory, { recursive: true, force: true });
  });
  return f;
}

const renderJob = (id = "job-1", input = {}) => ({ id, kind: "render", estMinutes: 10, input });
const tick = () => new Promise(resolve => setImmediate(resolve));
/** A poll sleep that moves the fake clock instead of waiting. */
const clockSleep = (clock, ms = 30_000) => async () => { clock.advance(ms); await tick(); };

// ---------------------------------------------------------------------------
// Provision: the provider-side timeout policy
// ---------------------------------------------------------------------------

test("provision submits the job with RunPod's executionTimeout and ttl derived from the lease's max lifetime", async t => {
  const f = await fixture(t); const manager = f.manager();
  const task = f.task();
  const { lease, instance } = await manager.start({ tenantId: "owner", taskId: task.id, job: renderJob("job-1", { scene: "intro.blend", frames: [1, 24] }) });
  // estimate = 10 min + overhead rounded to 1 min; lifetime = 11 min x 1.5
  assert.equal(lease.maxLifetimeSec, 990);
  assert.equal(lease.gpuType, "AMPERE_24");
  assert.equal(lease.reservedMicroUsd, RATE * 990);
  const run = f.server.requests.find(r => r.path.endsWith("/run"));
  assert.equal(run.authorized, true, "the key is sent as a bearer token");
  assert.deepEqual(run.body.input, { scene: "intro.blend", frames: [1, 24] });
  assert.deepEqual(run.body.policy, { executionTimeout: (990 - OVERHEAD_SEC) * 1000, ttl: (990 - OVERHEAD_SEC) * 1000 + QUEUE_TTL_SEC * 1000 },
    "RunPod itself stops the job: execution + billing overhead never passes the reserved lifetime");
  assert.equal(instance.state, "running");
  assert.ok(instance.tags.includes(ATLAS_TAG) && instance.tags.includes(`atlas-lease:${lease.id}`));
  await manager.finish("owner", lease.id);
});

test("a lifetime too short for RunPod's minimums is refused and the reservation released", async t => {
  const f = await fixture(t); const provider = f.provider();
  await assert.rejects(provider.provision({ gpuType: "AMPERE_24", maxLifetimeSec: OVERHEAD_SEC + 4, tags: [ATLAS_TAG] }), { code: "LIFETIME_TOO_SHORT" });
  assert.equal(f.server.requests.length, 0);
  const manager = f.manager({ maxLifetimeCapSec: OVERHEAD_SEC + 4 });
  const task = f.task();
  await assert.rejects(manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() }), { code: "PROVISION_FAILED" });
  assert.equal(f.usage(task.id), 0);
  assert.equal(f.server.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Status polling, outputs, settlement
// ---------------------------------------------------------------------------

test("runJob polls a job from IN_QUEUE to COMPLETED, saves its output as an artifact, and settles the derived bill", async t => {
  const f = await fixture(t); const manager = f.manager();
  const artifacts = new ArtifactStore({ root: join(f.directory, "artifacts") });
  t.after(() => artifacts.close?.());
  const task = f.task();
  const seen = [];
  const result = await manager.runJob({
    tenantId: "owner", taskId: task.id,
    job: renderJob("job-ok", { durationMs: 95_000, output: { frame: PNG_1PX } }),
    execute: async ({ instance, heartbeat, signal }) => manager.provider.waitForCompletion(instance.id, {
      signal, heartbeat: () => { seen.push(f.server.statusOf(instance.id)); return heartbeat(); }, sleep: clockSleep(f.clock),
    }),
    saveOutputs: async (output, { jobId, leaseId }) => {
      const { artifact } = await artifacts.put({ tenantId: "owner", kind: "file", mediaType: "image/png", bytes: Buffer.from(output.frame, "base64"),
        provenance: { runId: leaseId, step: "render", source: "runpod" }, name: `${jobId}.png` });
      return artifact;
    },
  });
  assert.equal(result.status, "succeeded", String(result.error?.code ?? ""));
  assert.deepEqual([...new Set(seen)], ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]);
  assert.equal((await artifacts.list("owner")).length, 1);
  const lease = manager.getLease("owner", result.leaseId);
  assert.equal(lease.state, "settled");
  const instanceId = lease.instanceId;
  assert.equal(lease.actualMicroUsd, (95 + OVERHEAD_SEC) * RATE, "execution time + idle + cold start at the endpoint's rate");
  assert.ok(lease.actualMicroUsd >= f.server.billedSeconds(instanceId) * RATE, "Atlas never settles below what the worker billed");
  assert.equal(f.usage(task.id), lease.actualMicroUsd);
  assert.deepEqual(f.server.running(), []);
});

test("a FAILED job fails the run, skips outputs and settles its execution time", async t => {
  const f = await fixture(t); const manager = f.manager(); const task = f.task();
  let saved = false;
  const result = await manager.runJob({ tenantId: "owner", taskId: task.id, job: renderJob("job-bad", { durationMs: 40_000, fail: true }),
    execute: ({ instance, heartbeat, signal }) => manager.provider.waitForCompletion(instance.id, { signal, heartbeat, sleep: clockSleep(f.clock, 20_000) }),
    saveOutputs: async () => { saved = true; } });
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "RUNPOD_JOB_FAILED");
  assert.equal(saved, false);
  assert.equal(manager.getLease("owner", result.leaseId).actualMicroUsd, (40 + OVERHEAD_SEC) * RATE);
});

// ---------------------------------------------------------------------------
// Cancel / terminate
// ---------------------------------------------------------------------------

test("finish cancels a running job on RunPod and settles what it ran", async t => {
  const f = await fixture(t); const manager = f.manager(); const task = f.task();
  const { lease, instance } = await manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  f.clock.advance(2 * MINUTE);
  assert.equal(f.server.statusOf(instance.id), "IN_PROGRESS");
  const result = await manager.finish("owner", lease.id, { outcome: "failed" });
  assert.equal(result.settled, true);
  assert.ok(f.server.requests.some(r => r.method === "POST" && r.path.endsWith(`/cancel/${instance.id}`)));
  assert.equal(f.server.statusOf(instance.id), "CANCELLED");
  assert.deepEqual(f.server.running(), []);
  const settled = manager.getLease("owner", lease.id);
  assert.equal(settled.actualMicroUsd, (118 + OVERHEAD_SEC) * RATE); // 2 min minus the 2 s queue wait
  assert.equal(f.usage(task.id), settled.actualMicroUsd);
  // terminate is idempotent: a second call answers from the journal without another cancel
  const cancels = f.server.requests.filter(r => r.path.includes("/cancel/")).length;
  assert.equal((await manager.provider.terminate(instance.id)).state, "terminated");
  assert.equal(f.server.requests.filter(r => r.path.includes("/cancel/")).length, cancels);
});

test("a job cancelled while still queued is settled from elapsed time, never below zero and never above the reservation", async t => {
  const f = await fixture(t); const manager = f.manager(); const task = f.task();
  const { lease, instance } = await manager.start({ tenantId: "owner", taskId: task.id, job: renderJob("job-q", { queueMs: 10 * MINUTE }) });
  f.clock.advance(MINUTE);
  await manager.finish("owner", lease.id);
  assert.equal(f.server.statusOf(instance.id), "CANCELLED");
  const settled = manager.getLease("owner", lease.id);
  assert.equal(settled.actualMicroUsd, (60 + IDLE_SEC) * RATE, "no execution time: bounded by time since submission plus idle");
  assert.ok(settled.actualMicroUsd <= settled.reservedMicroUsd);
});

// ---------------------------------------------------------------------------
// Provider-side max lifetime with Atlas gone
// ---------------------------------------------------------------------------

test("RunPod stops the job at its executionTimeout with Atlas crashed; the restarted reconciler settles it within the reservation", async t => {
  const f = await fixture(t, { idleTimeoutSec: 3600 });
  let crashed = f.manager(); const task = f.task();
  const { lease, instance } = await crashed.start({ tenantId: "owner", taskId: task.id, job: renderJob() });
  crashed = null; // nobody heartbeats, cancels or reconciles
  f.clock.advance(20 * MINUTE); // past the timeout, inside RunPod's 30-minute result window (after it: see the next test)
  assert.equal(f.server.statusOf(instance.id), "TIMED_OUT", "RunPod enforced the policy on its own");
  assert.deepEqual(f.server.running(), []);
  assert.ok(f.server.billedSeconds(instance.id) * RATE <= lease.reservedMicroUsd, "the worker billed no more than was reserved");
  f.openStore();
  const restarted = f.manager();
  await restarted.reconcile({ takeover: true });
  const settled = restarted.getLease("owner", lease.id);
  assert.equal(settled.state, "settled"); assert.equal(settled.endReason, "max_lifetime");
  assert.equal(settled.actualMicroUsd, settled.reservedMicroUsd, "ran to the executionTimeout: execution + overhead is exactly the reserved lifetime");
  assert.equal(f.usage(task.id), settled.reservedMicroUsd);
});

test("a job whose result RunPod has already deleted settles at the full reservation", async t => {
  const f = await fixture(t, { idleTimeoutSec: 48 * 3600 }); const manager = f.manager(); const task = f.task();
  const { lease } = await manager.start({ tenantId: "owner", taskId: task.id, job: renderJob("job-gone", { durationMs: 60_000 }) });
  f.clock.advance(2 * 3600_000); // completed, then the 30-minute result window passed
  await manager.finish("owner", lease.id);
  const settled = manager.getLease("owner", lease.id);
  assert.equal(settled.actualMicroUsd, null);
  assert.equal(f.usage(task.id), settled.reservedMicroUsd, "an unprovable bill keeps the whole reservation");
});

// ---------------------------------------------------------------------------
// Orphans and chaos
// ---------------------------------------------------------------------------

test("the reconciler cancels an Atlas job in the journal whose lease does not exist", async t => {
  const f = await fixture(t); const manager = f.manager();
  const stray = await manager.provider.provision({ gpuType: "AMPERE_24", maxLifetimeSec: 3600, tags: [ATLAS_TAG, "atlas-tenant:owner", "atlas-lease:lost"] });
  const live = await manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob() });
  f.clock.advance(MINUTE);
  const report = await manager.reconcile();
  assert.deepEqual(report.orphansTerminated.map(o => o.instanceId), [stray.id]);
  assert.equal(f.server.statusOf(stray.id), "CANCELLED");
  assert.equal(f.server.statusOf(live.instance.id), "IN_PROGRESS", "a live lease's job is left alone");
  await manager.finish("owner", live.lease.id);
  assert.deepEqual(f.server.running(), []);
});

test("chaos: Atlas crashing mid-job leaves zero running RunPod jobs after restart, and usage equals the derived bills", async t => {
  const f = await fixture(t, { idleTimeoutSec: 600 });
  let crashed = f.manager(); const task = f.task();
  for (const id of ["job-a", "job-b"]) {
    let heartbeat;
    void crashed.runJob({ tenantId: "owner", taskId: task.id, job: renderJob(id),
      execute: (ctx) => { heartbeat = ctx.heartbeat; return new Promise(() => {}); } }); // never finishes
    for (let i = 0; i < 20 && !heartbeat; i++) await tick();
    assert.equal(typeof heartbeat, "function");
  }
  f.clock.advance(3 * MINUTE);
  assert.equal(f.server.running().length, 2);
  // Crash: drop the manager and the adapter; keep both databases and RunPod's state.
  crashed = null;
  f.openStore();
  const restarted = f.manager();
  let scheduled = null;
  const first = await restarted.startReconciler({ intervalMs: 30_000, setIntervalImpl: (fn) => { scheduled = fn; return 1; }, clearIntervalImpl: () => { scheduled = null; } });
  assert.equal(first.ended.length, 2);
  assert.deepEqual(f.server.running(), [], "zero orphan jobs on RunPod");
  let total = 0;
  for (const lease of restarted.listLeases("owner")) {
    assert.equal(lease.state, "settled"); assert.equal(lease.endReason, "orphaned");
    assert.equal(f.server.statusOf(lease.instanceId), "CANCELLED");
    assert.equal(lease.actualMicroUsd, (178 + OVERHEAD_SEC) * RATE);
    assert.ok(lease.actualMicroUsd >= f.server.billedSeconds(lease.instanceId) * RATE);
    total += lease.actualMicroUsd;
  }
  assert.equal(f.usage(task.id), total);
  await restarted.reconcile({ takeover: true });
  assert.equal(f.usage(task.id), total, "re-running the reconciler releases nothing twice");
  assert.deepEqual(reconcileTaskBudgets({ store: f.store, tenantId: "owner" }).updates, []);
  restarted.stopReconciler(); assert.equal(scheduled, null);
});

test("chaos: a crash while /run is in flight (job created, id never recorded) keeps the full reservation and RunPod still stops the job", async t => {
  const f = await fixture(t);
  const crashed = f.manager(); const task = f.task();
  f.server.fault("run", { hang: true, createJob: true });
  void crashed.start({ tenantId: "owner", taskId: task.id, job: renderJob() }).catch(() => {});
  for (let i = 0; i < 50 && f.server.jobs.size === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.server.jobs.size, 1);
  const [pending] = crashed.listLeases("owner");
  assert.equal(pending.state, "provisioning"); assert.equal(pending.instanceId, null);
  const restarted = f.manager();
  await restarted.reconcile({ takeover: true });
  const lease = restarted.getLease("owner", pending.id);
  assert.equal(lease.state, "settled");
  assert.equal(lease.actualMicroUsd, null, "the bill of a job Atlas cannot see is not assumed to be zero");
  assert.equal(f.usage(task.id), lease.reservedMicroUsd);
  // The invisible job is bounded by the policy it was submitted with.
  const [job] = f.server.jobs.values();
  assert.equal(job.policy.executionTimeout, (lease.maxLifetimeSec - OVERHEAD_SEC) * 1000);
  f.clock.advance(lease.maxLifetimeSec * 1000 + QUEUE_TTL_SEC * 1000);
  assert.deepEqual(f.server.running(), []);
  assert.ok(f.server.billedSeconds(job.id) * RATE <= lease.reservedMicroUsd);
  assert.equal((await restarted.reconcile()).orphansTerminated.length, 0, "the abandoned journal row is not listed again");
});

test("a 5xx from /run may have created a job: the reservation is kept, a 4xx is a definite refusal and is released", async t => {
  const f = await fixture(t); const manager = f.manager();
  const maybe = f.task();
  f.server.fault("run", { status: 503, createJob: true });
  await assert.rejects(manager.start({ tenantId: "owner", taskId: maybe.id, job: renderJob("job-5xx") }), { code: "PROVISION_FAILED" });
  const [kept] = manager.listLeases("owner");
  assert.equal(kept.state, "settled"); assert.equal(kept.actualMicroUsd, null);
  assert.equal(f.usage(maybe.id), kept.reservedMicroUsd);
  const refused = f.task();
  f.server.fault("run", { status: 400 });
  await assert.rejects(manager.start({ tenantId: "owner", taskId: refused.id, job: renderJob("job-4xx") }), { code: "PROVISION_FAILED" });
  assert.equal(f.usage(refused.id), 0);
});

// ---------------------------------------------------------------------------
// Monthly cap
// ---------------------------------------------------------------------------

test("cap 0 (the default) turns GPU spending off: nothing reaches RunPod and nothing is reserved", async t => {
  const f = await fixture(t, { monthlyCapMicroUsd: 0 });
  const manager = f.manager(); const task = f.task();
  await assert.rejects(manager.start({ tenantId: "owner", taskId: task.id, job: renderJob() }), { code: "GPU_SPENDING_OFF" });
  assert.equal(f.server.requests.length, 0);
  assert.equal(f.usage(task.id), 0);
  assert.deepEqual(manager.listLeases("owner"), []);
  assert.equal(manager.listAudit("owner").at(-1).action, "cap.refused");
  assert.equal(new ComputeManager({ store: f.store }).monthlySpend("owner").capMicroUsd, 0, "a manager built without a cap refuses GPU spend");
});

test("the monthly cap refuses a provision once settled + reserved spend would pass it, per tenant and per UTC month", async t => {
  const reservation = RATE * 990;
  const f = await fixture(t, { monthlyCapMicroUsd: reservation * 2 });
  const manager = f.manager();
  const a = await manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob("a") });
  const b = await manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob("b") });
  const third = f.task();
  await assert.rejects(manager.start({ tenantId: "owner", taskId: third.id, job: renderJob("c") }), { code: "MONTHLY_CAP_EXCEEDED" });
  assert.equal(f.usage(third.id), 0, "a refused job reserves nothing");
  assert.equal(f.server.requests.filter(r => r.path.endsWith("/run")).length, 2);
  assert.deepEqual(manager.monthlySpend("owner"), { month: "2026-10", capMicroUsd: reservation * 2, settledMicroUsd: 0, reservedMicroUsd: reservation * 2, totalMicroUsd: reservation * 2, remainingMicroUsd: 0 });
  // Another tenant has its own month.
  const other = await manager.start({ tenantId: "other", taskId: f.task(undefined, "other").id, job: renderJob("o") });
  // Settling frees what was reserved but not spent.
  f.clock.advance(MINUTE);
  await manager.finish("owner", a.lease.id);
  const spend = manager.monthlySpend("owner");
  assert.equal(spend.settledMicroUsd, manager.getLease("owner", a.lease.id).actualMicroUsd);
  assert.ok(spend.remainingMicroUsd < reservation, "what was billed stays counted");
  // The lifetime shrinks to the cap that is left (never below the estimate).
  const fits = await manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob("d", {}) });
  assert.ok(fits.lease.reservedMicroUsd <= spend.remainingMicroUsd);
  assert.ok(manager.monthlySpend("owner").totalMicroUsd <= reservation * 2);
  for (const lease of [b.lease, fits.lease]) await manager.finish("owner", lease.id);
  await manager.finish("other", other.lease.id);
  // A new UTC month starts from zero.
  f.clock.advance(31 * 24 * 3600_000);
  assert.equal(manager.monthlySpend("owner").totalMicroUsd, 0);
  const next = await manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob("e") });
  await manager.finish("owner", next.lease.id);
});

test("the cap check and the lease insert are atomic in the lease store", async t => {
  const f = await fixture(t);
  const leases = new ComputeLeaseStore(f.leaseFile); t.after(() => leases.close());
  const base = { tenantId: "owner", jobId: "j", taskId: "t", provider: "runpod", gpuType: "AMPERE_24", holder: "h", rateMicroUsdPerSec: 1,
    maxLifetimeSec: 10, idleTimeoutSec: 10, createdAt: 100, leaseExpiresAt: 200, deadlineAt: 200 };
  const window = { capMicroUsd: 1_000, fromMs: 0, toMs: 1_000 };
  assert.ok(leases.insertWithinCap({ ...base, id: "l1", reservedMicroUsd: 600 }, window));
  assert.equal(leases.insertWithinCap({ ...base, id: "l2", reservedMicroUsd: 401 }, window), null);
  assert.ok(leases.insertWithinCap({ ...base, id: "l3", reservedMicroUsd: 400 }, window));
  assert.equal(leases.spend("owner", 0, 1_000).totalMicroUsd, 1_000);
  assert.equal(leases.spend("other", 0, 1_000).totalMicroUsd, 0);
  assert.equal(leases.list("owner").length, 2);
});

// ---------------------------------------------------------------------------
// API errors and secrets
// ---------------------------------------------------------------------------

test("API errors carry codes, never the key or a response body, and nothing persisted holds the key", async t => {
  const f = await fixture(t); const manager = f.manager();
  const errors = [];
  // 401 whose body echoes the presented key
  const wrong = f.provider({ apiKey: async () => `${API_KEY}-wrong` });
  await wrong.provision({ gpuType: "AMPERE_24", maxLifetimeSec: 600, tags: [ATLAS_TAG] }).catch(error => errors.push(error));
  // 500, invalid JSON, unreachable host, no key at all
  f.server.fault("run", { status: 500 });
  await manager.provider.provision({ gpuType: "AMPERE_24", maxLifetimeSec: 600, tags: [ATLAS_TAG] }).catch(error => errors.push(error));
  f.server.fault("run", { badJson: true });
  await manager.provider.provision({ gpuType: "AMPERE_24", maxLifetimeSec: 600, tags: [ATLAS_TAG] }).catch(error => errors.push(error));
  const unreachable = f.provider({ baseUrl: "http://127.0.0.1:9/v2" });
  await unreachable.provision({ gpuType: "AMPERE_24", maxLifetimeSec: 600, tags: [ATLAS_TAG] }).catch(error => errors.push(error));
  const keyless = f.provider({ apiKey: async () => null });
  await keyless.provision({ gpuType: "AMPERE_24", maxLifetimeSec: 600, tags: [ATLAS_TAG] }).catch(error => errors.push(error));
  assert.deepEqual(errors.map(e => e.code), ["RUNPOD_HTTP_401", "RUNPOD_HTTP_500", "RUNPOD_BAD_RESPONSE", "RUNPOD_UNREACHABLE", "RUNPOD_NO_API_KEY"]);
  for (const error of errors) {
    const text = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
    assert.doesNotMatch(text, /TESTKEY/); assert.doesNotMatch(text, /invalid api key|upstream failure/);
  }
  // Through the manager, a failed provision audits only the code.
  const task = f.task();
  const badManager = f.manager({ provider: wrong });
  await assert.rejects(badManager.start({ tenantId: "owner", taskId: task.id, job: renderJob() }), { code: "PROVISION_FAILED" });
  assert.match(JSON.stringify(badManager.listAudit("owner")), /RUNPOD_HTTP_401/);
  assert.doesNotMatch(badManager.leases.dumpText(), /TESTKEY/);
  assert.doesNotMatch(JSON.stringify(f.store.listEvents("owner")), /TESTKEY/);
  assert.doesNotMatch(JSON.stringify(manager.provider), /TESTKEY/);
  assert.doesNotMatch((await readFile(f.leaseFile)).toString("latin1"), /TESTKEY/, "the journal never stores the key");
});

test("the key only travels over https (or to a loopback test server)", () => {
  for (const baseUrl of ["http://api.runpod.ai/v2", "ftp://api.runpod.ai/v2", "https://user:pw@api.runpod.ai/v2"]) {
    assert.throws(() => new RunpodProvider({ endpointId: "e1", apiKey: API_KEY, baseUrl }), { code: "INVALID_CONFIG" });
  }
  assert.ok(new RunpodProvider({ endpointId: "e1", apiKey: API_KEY }));
  assert.throws(() => new RunpodProvider({ endpointId: "../x", apiKey: API_KEY }), { code: "INVALID_CONFIG" });
});

// ---------------------------------------------------------------------------
// Pricing and configuration
// ---------------------------------------------------------------------------

test("pricing: documented defaults, overrides, worst-case pool and VRAM fit", async () => {
  assert.equal(resolveRunpodPricing().get("AMPERE_24").hourlyUsd, 0.68);
  assert.equal(resolveRunpodPricing({ AMPERE_24: 0.5 }).get("AMPERE_24").hourlyUsd, 0.5);
  assert.equal(resolveRunpodPricing([{ gpuType: "BLACKWELL_96", vramGb: 96, hourlyUsd: 5 }]).get("BLACKWELL_96").vramGb, 96);
  assert.throws(() => resolveRunpodPricing({ NEW_POOL: 1 }), { code: "INVALID_PRICING" });
  assert.throws(() => resolveRunpodPricing({ AMPERE_24: -1 }), { code: "INVALID_PRICING" });
  assert.ok(RUNPOD_DEFAULT_PRICING.every(entry => entry.hourlyUsd > 0 && entry.vramGb > 0));
  const mixed = new RunpodProvider({ endpointId: "e1", apiKey: API_KEY, gpuTypes: ["AMPERE_24", "ADA_24"] });
  const estimate = await mixed.estimate({ minVramGb: 12, estMinutes: 10 });
  assert.equal(estimate.gpuType, "AMPERE_24|ADA_24"); assert.equal(estimate.estHourlyUsd, 1.12, "reserve at the dearest pool the job may land on");
  assert.equal(await mixed.estimate({ minVramGb: 40 }), null);
  assert.throws(() => new RunpodProvider({ endpointId: "e1", apiKey: API_KEY, gpuTypes: ["NOPE_1"] }), { code: "INVALID_CONFIG" });
});

test("the daemon service is off by default and makes no request until configured", async t => {
  const f = await fixture(t);
  let calls = 0;
  const fetchImpl = async (...args) => { calls += 1; return fetch(...args); };
  const credentials = async (name) => (name === "ATLAS_RUNPOD_API_KEY" ? API_KEY : null);
  const base = { credentials, store: f.store, leaseDb: f.leaseFile, fetchImpl, clock: f.clock };
  assert.equal((await createComputeService({ ...base, env: {} })).enabled, false);
  assert.equal((await createComputeService({ ...base, env: { ATLAS_RUNPOD_ENDPOINT_ID: f.server.endpointId }, credentials: async () => null })).enabled, false);
  const off = await createComputeService({ ...base, env: { ATLAS_RUNPOD_ENDPOINT_ID: f.server.endpointId, ATLAS_RUNPOD_BASE_URL: f.server.baseUrl } });
  assert.equal(off.enabled, true); assert.equal(off.provisioning, false);
  await assert.rejects(off.manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob() }), { code: "GPU_SPENDING_OFF" });
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(off), /TESTKEY/);
  const on = await createComputeService({ ...base, env: { ATLAS_RUNPOD_ENDPOINT_ID: f.server.endpointId, ATLAS_RUNPOD_BASE_URL: f.server.baseUrl,
    ATLAS_GPU_MONTHLY_CAP_USD: "25", ATLAS_RUNPOD_IDLE_TIMEOUT_SEC: "5", ATLAS_RUNPOD_COLD_START_SEC: "25" } });
  assert.equal(on.provisioning, true); assert.equal(on.capMicroUsd, 25_000_000);
  const { lease } = await on.manager.start({ tenantId: "owner", taskId: f.task().id, job: renderJob() });
  assert.equal(calls, 1);
  await on.manager.finish("owner", lease.id);
  assert.deepEqual(parseMonthlyCapUsd(undefined), { capMicroUsd: 0, valid: true });
  assert.deepEqual(parseMonthlyCapUsd("12.5"), { capMicroUsd: 12_500_000, valid: true });
  assert.deepEqual(parseMonthlyCapUsd("-3"), { capMicroUsd: 0, valid: false });
  assert.deepEqual(parseMonthlyCapUsd("lots"), { capMicroUsd: 0, valid: false });
});
