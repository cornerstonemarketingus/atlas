import { randomUUID } from "node:crypto";

import { TaskBudget, TaskBudgetExceededError } from "../budget.mjs";
import { ACTIVE_STATES, ComputeLeaseStore, PENDING_STATES } from "./lease-store.mjs";
import { ATLAS_TAG, assertProvider, microUsdPerSecond } from "./provider.mjs";
import { detectRequirements } from "./requirements.mjs";

/**
 * Rents GPUs for jobs so that no single failure can leave a bill running
 * (issue #353, engineering plan §3.2). Four independent stops:
 *
 *  1. Budget reservation before provisioning. The worst-case cost
 *     (per-second rate x max lifetime) is reserved on the job's task through
 *     the existing TaskBudget, so every ancestor and sibling sees it. No
 *     approved `costMicroUsd` limit, or an estimate above what is left, and
 *     nothing is provisioned.
 *  2. Provider-side max lifetime, set at creation. A crashed Atlas still
 *     stops billing, and the reservation already covers that lifetime.
 *  3. Idle timeout: each heartbeat extends the lease by `idleTimeoutSec`; a
 *     lease that is not extended expires and its instance is terminated.
 *  4. `reconcile()`: lists Atlas-tagged instances and terminates any without
 *     a live lease. Run it at startup (with `takeover`) and on an interval.
 *
 * Instances are terminated when their job succeeds or fails. The actual
 * provider bill is then settled against the reservation: the unused part is
 * released through TaskBudget.release (idempotent by lease ref), an overrun
 * is charged truthfully. Every provision, termination and settlement is
 * audited without secrets.
 */

export const DEFAULT_IDLE_TIMEOUT_SEC = 300;
export const DEFAULT_MAX_LIFETIME_CAP_SEC = 4 * 3600;
export const DEFAULT_LIFETIME_SAFETY = 1.5;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export class ComputeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ComputeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const leaseRef = (leaseId) => `compute-lease:${leaseId}`;
const leaseTag = (leaseId) => `atlas-lease:${leaseId}`;
const tagValue = (tags, prefix) => (tags ?? []).find(tag => tag.startsWith(prefix))?.slice(prefix.length) ?? null;

export class ComputeManager {
  #store;
  #leases;
  #providers = new Map();
  #now;
  #idleTimeoutSec;
  #maxLifetimeCapSec;
  #lifetimeSafety;
  #localHardware;
  #controllers = new Map();
  #locks = new Map();
  #timer = null;
  #clearTimer = null;

  /**
   * @param options.store PlatformTaskStore holding the job tasks and their budgets
   * @param options.leaseDb filename or DatabaseSync for the lease table (or `leases`, a ComputeLeaseStore)
   * @param options.providers compute providers (see provider.mjs)
   * @param options.clock () => ms, or { now() }
   */
  constructor({ store, leaseDb = ":memory:", leases = undefined, providers = [], clock = () => Date.now(), idleTimeoutSec = DEFAULT_IDLE_TIMEOUT_SEC,
    maxLifetimeCapSec = DEFAULT_MAX_LIFETIME_CAP_SEC, lifetimeSafety = DEFAULT_LIFETIME_SAFETY, localHardware = null, managerId = randomUUID() } = {}) {
    if (!store) throw new ComputeError("INVALID_ARGUMENT", "ComputeManager needs the platform task store for budgets.");
    if (!Number.isInteger(idleTimeoutSec) || idleTimeoutSec <= 0) throw new ComputeError("INVALID_ARGUMENT", "idleTimeoutSec must be a positive integer.");
    if (!Number.isInteger(maxLifetimeCapSec) || maxLifetimeCapSec <= 0) throw new ComputeError("INVALID_ARGUMENT", "maxLifetimeCapSec must be a positive integer.");
    this.#store = store;
    this.#leases = leases ?? new ComputeLeaseStore(leaseDb);
    for (const provider of providers) this.#providers.set(assertProvider(provider).name, provider);
    this.#now = typeof clock === "function" ? clock : () => clock.now();
    this.#idleTimeoutSec = idleTimeoutSec;
    this.#maxLifetimeCapSec = maxLifetimeCapSec;
    this.#lifetimeSafety = lifetimeSafety;
    this.#localHardware = localHardware;
    this.managerId = managerId;
  }

  get leases() { return this.#leases; }

  getLease(tenantId, leaseId) { return this.#leases.get(tenantId, leaseId); }
  listLeases(tenantId, options) { return this.#leases.list(tenantId, options); }
  listAudit(tenantId, options) { return this.#leases.listAudit(tenantId, options); }

  /** Picks the cheapest provider/GPU that meets the job's requirements; `null` plan when it should run locally. */
  async plan(job) {
    const requirements = detectRequirements(job, { localHardware: this.#localHardware });
    if (requirements.runLocally) return { requirements, choice: null };
    let best = null;
    for (const provider of this.#providers.values()) {
      const estimate = await provider.estimate({ ...job, minVramGb: requirements.minVramGb, estMinutes: requirements.estMinutes });
      if (!estimate) continue;
      const rate = microUsdPerSecond(estimate.estHourlyUsd);
      const estMicroUsd = rate * Math.ceil(estimate.estMinutes * 60);
      if (!best || estMicroUsd < best.estMicroUsd) best = { provider: provider.name, ...estimate, rateMicroUsdPerSec: rate, estMicroUsd };
    }
    if (!best) throw new ComputeError("NO_GPU_AVAILABLE", `No provider offers a GPU with at least ${requirements.minVramGb} GB.`);
    return { requirements, choice: best };
  }

  /**
   * Reserves budget, records the lease, then provisions. Returns
   * `{ runLocally: true }` when no rental is needed, else
   * `{ lease, instance, signal }`; `signal` aborts when the lease is ended
   * by anything other than the caller (idle, max lifetime, reconcile).
   */
  async start({ tenantId, taskId, job }) {
    if (!ID_PATTERN.test(String(tenantId))) throw new ComputeError("INVALID_ARGUMENT", "tenantId must be a short identifier.");
    if (!ID_PATTERN.test(String(job?.id))) throw new ComputeError("INVALID_ARGUMENT", "job.id must be a short identifier.");
    const { requirements, choice } = await this.plan(job);
    if (!choice) return { runLocally: true, requirements };

    // Stop 1: reserve the worst case before anything is provisioned.
    const budget = new TaskBudget({ store: this.#store, tenantId, taskId });
    const remaining = budget.snapshot().remaining.costMicroUsd;
    if (remaining === undefined) throw new ComputeError("NO_APPROVED_BUDGET", "The task has no approved costMicroUsd budget; GPU time is never rented without one.");
    if (choice.estMicroUsd > remaining) {
      throw new ComputeError("ESTIMATE_EXCEEDS_BUDGET", `Estimated GPU cost ${choice.estMicroUsd} micro-USD exceeds the remaining ${remaining}.`, { estimate: choice.estMicroUsd, remaining });
    }
    const wantedSec = requirements.maxMinutes ? Math.ceil(requirements.maxMinutes * 60) : Math.ceil(choice.estMinutes * 60 * this.#lifetimeSafety);
    const maxLifetimeSec = Math.min(this.#maxLifetimeCapSec, wantedSec, Math.floor(remaining / choice.rateMicroUsdPerSec));
    if (maxLifetimeSec <= 0) throw new ComputeError("ESTIMATE_EXCEEDS_BUDGET", "The remaining budget does not cover one second of GPU time.");
    const reservedMicroUsd = choice.rateMicroUsdPerSec * maxLifetimeSec;
    try {
      budget.reserve({ costMicroUsd: reservedMicroUsd });
    } catch (error) {
      if (error instanceof TaskBudgetExceededError) throw new ComputeError("BUDGET_EXCEEDED", error.message, { remaining });
      throw error;
    }

    const now = this.#now();
    const lease = this.#leases.insert({
      tenantId, id: randomUUID(), jobId: job.id, taskId, provider: choice.provider, gpuType: choice.gpuType, holder: this.managerId,
      reservedMicroUsd, rateMicroUsdPerSec: choice.rateMicroUsdPerSec, maxLifetimeSec, idleTimeoutSec: this.#idleTimeoutSec,
      createdAt: now, leaseExpiresAt: now + this.#idleTimeoutSec * 1000, deadlineAt: now + maxLifetimeSec * 1000,
    });
    this.#leases.audit(tenantId, lease.id, "reserve", now, { jobId: job.id, taskId, provider: choice.provider, gpuType: choice.gpuType,
      reservedMicroUsd, maxLifetimeSec, estHourlyUsd: choice.estHourlyUsd, estMinutes: choice.estMinutes });
    const controller = new AbortController();
    this.#controllers.set(lease.id, controller);

    // Stop 2: the provider enforces maxLifetimeSec on its own.
    const provider = this.#providers.get(choice.provider);
    let instance;
    try {
      instance = await provider.provision({ gpuType: choice.gpuType, maxLifetimeSec,
        tags: [ATLAS_TAG, `atlas-tenant:${tenantId}`, leaseTag(lease.id), `atlas-job:${job.id}`] });
    } catch (error) {
      this.#leases.audit(tenantId, lease.id, "provision.failed", this.#now(), { jobId: job.id, provider: choice.provider, error: String(error?.code ?? "PROVISION_FAILED") });
      await this.#end(tenantId, lease.id, "provision_failed", { provisionFailed: true });
      throw new ComputeError("PROVISION_FAILED", "The GPU provider could not provision an instance; the reservation was released.");
    }
    const at = this.#now();
    const running = this.#leases.update(tenantId, lease.id, ["provisioning"], { state: "running", instanceId: instance.id, provisionedAt: at,
      lastHeartbeatAt: at, leaseExpiresAt: at + this.#idleTimeoutSec * 1000 });
    this.#leases.audit(tenantId, lease.id, "provision", at, { jobId: job.id, provider: choice.provider, gpuType: choice.gpuType, instanceId: instance.id, maxLifetimeSec });
    if (!running) {
      // A reconciler ended the lease while we were provisioning: the instance
      // must not survive. That settlement could not see this instance's bill,
      // so it kept the full reservation, which covers it.
      await this.#end(tenantId, lease.id, "reconciled");
      const final = await provider.terminate(instance.id).catch(() => null);
      this.#leases.audit(tenantId, lease.id, "terminate", this.#now(), { jobId: job.id, provider: choice.provider, instanceId: instance.id,
        reason: "lease_lost", actualMicroUsd: final?.billedMicroUsd ?? null });
      throw new ComputeError("LEASE_LOST", "The lease ended while the instance was provisioning; it was terminated.");
    }
    return { lease: running, instance, signal: controller.signal };
  }

  /** Stop 3: a job proves it is alive. Returns false once the lease is no longer running. */
  heartbeat(tenantId, leaseId) {
    const now = this.#now();
    const lease = this.#leases.get(tenantId, leaseId);
    if (!lease || lease.state !== "running" || lease.leaseExpiresAt <= now) return false;
    return Boolean(this.#leases.update(tenantId, leaseId, ["running"], { lastHeartbeatAt: now, leaseExpiresAt: now + lease.idleTimeoutSec * 1000 }));
  }

  /** Terminates the instance for a finished job and settles its cost. */
  async finish(tenantId, leaseId, { outcome = "succeeded" } = {}) {
    return this.#end(tenantId, leaseId, outcome === "succeeded" ? "job_succeeded" : "job_failed");
  }

  /**
   * Full job lifecycle: start, run `execute({ instance, heartbeat, signal })`,
   * hand its result to `saveOutputs` while the instance still exists, and
   * terminate whether the job succeeded or failed.
   */
  async runJob({ tenantId, taskId, job, execute, saveOutputs = undefined }) {
    if (typeof execute !== "function") throw new ComputeError("INVALID_ARGUMENT", "runJob needs an execute callback.");
    const started = await this.start({ tenantId, taskId, job });
    if (started.runLocally) return { status: "local", requirements: started.requirements };
    const { lease, instance, signal } = started;
    let status = "failed"; let outputs; let error;
    try {
      outputs = await execute({ instance, leaseId: lease.id, signal, heartbeat: () => this.heartbeat(tenantId, lease.id) });
      if (signal.aborted) throw new ComputeError("LEASE_ENDED", `The lease ended before the job finished (${signal.reason ?? "ended"}).`);
      if (saveOutputs) await saveOutputs(outputs, { instance, leaseId: lease.id, jobId: job.id });
      status = "succeeded";
    } catch (caught) {
      error = caught;
    }
    const settlement = await this.finish(tenantId, lease.id, { outcome: status });
    return { status, leaseId: lease.id, outputs: status === "succeeded" ? outputs : undefined, error, settlement };
  }

  /**
   * Stop 4. Ends every lease that is no longer live (idle, past its deadline,
   * terminated provider-side, or, with `takeover`, held by a previous manager
   * process), terminates every Atlas-tagged instance without a live lease,
   * and finishes any settlement a crash interrupted.
   */
  async reconcile({ takeover = false } = {}) {
    const report = { ended: [], orphansTerminated: [], settled: [], errors: [] };
    const now = this.#now();
    for (const lease of this.#leases.listByStates(ACTIVE_STATES)) {
      const reason = this.#deadReason(lease, now, takeover) ?? await this.#providerEnded(lease);
      if (!reason) continue;
      const result = await this.#end(lease.tenantId, lease.id, reason);
      (result.settled ? report.ended : report.errors).push({ leaseId: lease.id, reason, ...(result.error ? { error: result.error } : {}) });
    }
    for (const lease of this.#leases.listByStates(PENDING_STATES)) {
      const result = await this.#end(lease.tenantId, lease.id, lease.endReason ?? "reconciled");
      if (result.settled) report.settled.push(lease.id); else report.errors.push({ leaseId: lease.id, error: result.error });
    }
    for (const provider of this.#providers.values()) {
      let tagged;
      try { tagged = await provider.listTagged(ATLAS_TAG); } catch (error) { report.errors.push({ provider: provider.name, error: String(error?.code ?? "LIST_FAILED") }); continue; }
      for (const instance of tagged) {
        const tenantId = tagValue(instance.tags, "atlas-tenant:");
        const leaseId = tagValue(instance.tags, "atlas-lease:");
        const lease = tenantId && leaseId ? this.#leases.get(tenantId, leaseId) : null;
        if (lease && this.#isLive(lease, this.#now(), takeover) && (lease.instanceId === instance.id || (lease.state === "provisioning" && !lease.instanceId))) continue;
        if (lease && lease.state !== "settled") {
          const result = await this.#end(tenantId, leaseId, "orphaned");
          (result.settled ? report.orphansTerminated : report.errors).push({ instanceId: instance.id, leaseId, ...(result.error ? { error: result.error } : {}) });
          continue;
        }
        try {
          const final = await provider.terminate(instance.id);
          this.#leases.audit(tenantId ?? "unknown", leaseId, "terminate", this.#now(), { provider: provider.name, instanceId: instance.id, reason: "orphaned",
            actualMicroUsd: final?.billedMicroUsd ?? null, unattributed: !lease });
          report.orphansTerminated.push({ instanceId: instance.id, leaseId });
        } catch (error) {
          report.errors.push({ instanceId: instance.id, error: String(error?.code ?? "TERMINATE_FAILED") });
        }
      }
    }
    return report;
  }

  /** Runs `reconcile({ takeover: true })` now, then `reconcile()` every `intervalMs`. */
  async startReconciler({ intervalMs = 60_000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, onReport = () => {}, onError = () => {} } = {}) {
    if (this.#timer) return;
    const first = await this.reconcile({ takeover: true });
    onReport(first);
    this.#clearTimer = clearIntervalImpl;
    this.#timer = setIntervalImpl(() => { this.reconcile().then(onReport, onError); }, intervalMs);
    this.#timer?.unref?.();
    return first;
  }

  stopReconciler() {
    if (!this.#timer) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  #isLive(lease, now, takeover) {
    return ACTIVE_STATES.includes(lease.state) && lease.leaseExpiresAt > now && lease.deadlineAt > now && !(takeover && lease.holder !== this.managerId);
  }

  #deadReason(lease, now, takeover) {
    if (this.#isLive(lease, now, takeover)) return null;
    if (lease.deadlineAt <= now) return "max_lifetime";
    if (lease.leaseExpiresAt <= now) return "idle";
    return "orphaned";
  }

  async #providerEnded(lease) {
    if (lease.state !== "running" || !lease.instanceId) return null;
    const provider = this.#providers.get(lease.provider);
    if (!provider) return null;
    try {
      const status = await provider.status(lease.instanceId);
      if (!status) return "provider_missing";
      return status.state === "terminated" ? (status.terminationReason === "max_lifetime" ? "max_lifetime" : "provider_terminated") : null;
    } catch {
      return null;
    }
  }

  // One end/settle at a time per lease inside this process; across processes
  // the state-guarded updates and the idempotent release ref keep it safe.
  async #end(tenantId, leaseId, reason, options = {}) {
    const previous = this.#locks.get(leaseId) ?? Promise.resolve();
    const run = previous.then(() => this.#endLocked(tenantId, leaseId, reason, options));
    const tail = run.catch(() => {});
    this.#locks.set(leaseId, tail);
    try { return await run; } finally { if (this.#locks.get(leaseId) === tail) this.#locks.delete(leaseId); }
  }

  async #endLocked(tenantId, leaseId, reason, { provisionFailed = false } = {}) {
    let lease = this.#leases.get(tenantId, leaseId);
    if (!lease) return { settled: false, error: "LEASE_NOT_FOUND" };
    if (lease.state === "settled") return { settled: true, lease, alreadySettled: true };
    const now = this.#now();
    if (ACTIVE_STATES.includes(lease.state)) {
      lease = this.#leases.update(tenantId, leaseId, ACTIVE_STATES, { state: "terminating", endReason: reason, endedAt: now, leaseExpiresAt: now }) ?? this.#leases.get(tenantId, leaseId);
      const controller = this.#controllers.get(leaseId);
      if (controller && !controller.signal.aborted && !reason.startsWith("job_")) controller.abort(reason);
    }
    this.#controllers.delete(leaseId);

    if (lease.state === "terminating") {
      const terminated = await this.#terminateLeaseInstances(lease, provisionFailed);
      if (terminated.error) {
        this.#leases.audit(tenantId, leaseId, "terminate.failed", this.#now(), { instanceId: lease.instanceId, reason: lease.endReason, error: terminated.error });
        return { settled: false, error: terminated.error, lease };
      }
      const actual = terminated.actualMicroUsd;
      const released = actual === null ? 0 : Math.max(0, lease.reservedMicroUsd - actual);
      const excess = actual === null ? 0 : Math.max(0, actual - lease.reservedMicroUsd);
      lease = this.#leases.update(tenantId, leaseId, ["terminating"], { state: "settling", actualMicroUsd: actual, releasedMicroUsd: released, excessMicroUsd: excess })
        ?? this.#leases.get(tenantId, leaseId);
    }

    if (lease.state === "settling") {
      const budget = new TaskBudget({ store: this.#store, tenantId, taskId: lease.taskId });
      const ref = leaseRef(leaseId);
      if (lease.releasedMicroUsd > 0 && !budget.hasRelease(ref)) budget.release({ costMicroUsd: lease.releasedMicroUsd }, { ref });
      const excessDone = this.#leases.listAudit(tenantId, { leaseId }).some(entry => entry.action === "settle.excess");
      if (lease.excessMicroUsd > 0 && !excessDone) {
        budget.charge({ costMicroUsd: lease.excessMicroUsd });
        this.#leases.audit(tenantId, leaseId, "settle.excess", this.#now(), { excessMicroUsd: lease.excessMicroUsd });
      }
      const settled = this.#leases.update(tenantId, leaseId, ["settling"], { state: "settled" });
      if (settled) {
        this.#leases.audit(tenantId, leaseId, "settle", this.#now(), { jobId: lease.jobId, taskId: lease.taskId, reason: lease.endReason,
          reservedMicroUsd: lease.reservedMicroUsd, actualMicroUsd: lease.actualMicroUsd, releasedMicroUsd: lease.releasedMicroUsd, excessMicroUsd: lease.excessMicroUsd });
      }
      lease = this.#leases.get(tenantId, leaseId);
    }
    return { settled: lease.state === "settled", lease };
  }

  /**
   * Terminates the lease's recorded instance and any instance tagged with
   * the lease (a crash between provision and recording leaves only the tag).
   * Returns the summed final bill, or null when it cannot be proven, which
   * settles as the full reservation.
   */
  async #terminateLeaseInstances(lease, provisionFailed) {
    const provider = this.#providers.get(lease.provider);
    if (!provider) return { error: "PROVIDER_NOT_CONFIGURED" };
    try {
      const ids = new Set(lease.instanceId ? [lease.instanceId] : []);
      for (const instance of await provider.listTagged(leaseTag(lease.id))) ids.add(instance.id);
      let actual = 0; let unknown = false;
      for (const id of ids) {
        const final = await provider.terminate(id);
        this.#leases.audit(lease.tenantId, lease.id, "terminate", this.#now(), { jobId: lease.jobId, provider: lease.provider, instanceId: id,
          reason: lease.endReason, actualMicroUsd: final?.billedMicroUsd ?? null });
        if (!final || final.state !== "terminated" || !Number.isInteger(final.billedMicroUsd)) {
          if (final && final.state !== "terminated") return { error: "TERMINATE_NOT_CONFIRMED" };
          unknown = true;
        } else {
          actual += final.billedMicroUsd;
        }
      }
      // No instance found: proven free only when we saw the provision call fail.
      if (!ids.size && !provisionFailed) unknown = true;
      return { actualMicroUsd: unknown ? null : actual };
    } catch (error) {
      return { error: String(error?.code ?? "TERMINATE_FAILED") };
    }
  }
}
