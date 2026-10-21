import { ComputeError } from "../compute/manager.mjs";
import { NodeError, nodeRequirements } from "./service.mjs";

/**
 * The owner's Atlas Nodes as a compute provider (see compute/provider.mjs),
 * so ComputeManager schedules onto them with the same lease, max-lifetime,
 * idle-timeout and reconciler semantics as a rented GPU, at $0.
 *
 * An "instance" is one node job: `provision` queues it, a node claims and
 * runs it, `terminate` cancels it (a node still holding it gets CLAIM_LOST).
 * The instance reports `running` until it is terminated or passes its max
 * lifetime, exactly like a GPU box that finished its work but has not been
 * shut down yet, so a reconciler never ends a lease whose outputs are being
 * saved. Billing is always 0.
 *
 * Only render jobs (`job.render`, a RenderRunner job) run on nodes.
 * `job.minVramGb` (from requirements.mjs) above 0 needs a node GPU with that
 * much memory; 0 is a CPU render, which every approved node with the tool can do.
 */

export const NODE_GPU_TYPE = "atlas-node";

export class NodeProvider {
  #service;
  #pollMs;

  constructor({ service, name = "atlas-node", pollMs = 1_000 } = {}) {
    if (!service) throw new NodeError("INVALID_ARGUMENT", "NodeProvider needs the node service.");
    this.name = name;
    this.#service = service;
    this.#pollMs = pollMs;
  }

  #view(job) {
    if (!job) return null;
    return {
      id: job.id, gpuType: NODE_GPU_TYPE, tags: [...job.tags],
      state: job.terminatedAt === null ? "running" : "terminated",
      billedMicroUsd: 0,
      ...(job.terminationReason ? { terminationReason: job.terminationReason } : {}),
      job: { state: job.state, attempts: job.attempts, claimant: job.claimant },
    };
  }

  /** $0 when an approved, live node of the job's tenant can run it now; otherwise null (another provider may). */
  async estimate(job) {
    if (!job?.render || typeof job.tenantId !== "string") return null;
    const requirements = nodeRequirements({ tool: job.render.tool, minVramGb: job.minVramGb ?? 0, cpu: job.cpu });
    if (!this.#service.eligibleNodes(job.tenantId, { requirements, risk: job.risk ?? "moderate" }).length) return null;
    return { gpuType: NODE_GPU_TYPE, estHourlyUsd: 0, estMinutes: Math.max(1, Math.ceil(job.estMinutes ?? 10)) };
  }

  async provision({ maxLifetimeSec, tags = [], tenantId, job }) {
    if (!job?.render) throw new NodeError("INVALID_ARGUMENT", "Atlas Nodes run render jobs (job.render).");
    if (!Number.isInteger(maxLifetimeSec) || maxLifetimeSec <= 0) throw new NodeError("INVALID_ARGUMENT", "maxLifetimeSec must be a positive integer.");
    const queued = await this.#service.submit({
      tenantId, render: job.render, workspace: job.workspace ?? null, tags, risk: job.risk ?? "moderate",
      minVramGb: job.minVramGb ?? 0, cpu: job.cpu, deadlineAt: this.#now() + maxLifetimeSec * 1000,
    });
    return this.#view(queued);
  }

  #now() { return this.#service.now(); }

  async status(instanceId) { return this.#view(this.#service.expireDeadline(instanceId)); }

  async terminate(instanceId) {
    const job = this.#service.getJobById(instanceId);
    if (!job) return null;
    return this.#view(job.terminatedAt === null ? this.#service.terminate(instanceId, "requested") : job);
  }

  async listTagged(tag) {
    this.#service.sweep();
    return this.#service.listLiveJobs().map((job) => this.#view(this.#service.expireDeadline(job.id))).filter((view) => view.state === "running" && view.tags.includes(tag));
  }

  /**
   * The `execute` half of ComputeManager.runJob for a node job: waits for a
   * node to finish it, proving the lease alive while the job is alive.
   * Resolves with the verified outputs; throws when the job failed, was
   * cancelled, or the lease ended.
   */
  async awaitJob(instanceId, { heartbeat = () => true, signal = undefined, pollMs = this.#pollMs } = {}) {
    for (;;) {
      if (signal?.aborted) throw new ComputeError("LEASE_ENDED", `The lease ended before a node finished the job (${signal.reason ?? "ended"}).`);
      this.#service.sweep();
      const job = this.#service.getJobById(instanceId);
      if (!job) throw new ComputeError("NODE_JOB_MISSING", "The node job no longer exists.");
      if (job.state === "succeeded") return { jobId: job.id, outputs: job.outputs, attempts: job.attempts };
      if (job.state === "failed" || job.state === "cancelled") {
        throw new ComputeError(job.state === "failed" ? "NODE_JOB_FAILED" : "NODE_JOB_CANCELLED", job.error ?? `The node job ended: ${job.endReason ?? job.state}.`, { reason: job.endReason });
      }
      if (heartbeat() === false) throw new ComputeError("LEASE_ENDED", "The compute lease is no longer running.");
      await this.#service.waitForJob(instanceId, pollMs, signal);
    }
  }
}

/**
 * Providers for the ComputeManager. With no paid provider configured the
 * owner's nodes are the only (and so the default) provider; with one, nodes
 * still come first because the manager picks the cheapest offer and a node
 * costs nothing, and the paid provider takes what no live node can run.
 */
export function defaultComputeProviders({ nodeProvider, paid = [] }) {
  return paid.length ? [nodeProvider, ...paid] : [nodeProvider];
}

/**
 * A render job for ComputeManager.runJob that a node runs. CPU unless `gpu`
 * asks for one; `cpu` sizes it ({ minCores, minMemoryGiB }).
 */
export function nodeRenderJob({ id, render, workspace = null, gpu = null, cpu = undefined, estMinutes = 10, maxMinutes = undefined, risk = "moderate" }) {
  return {
    id, kind: "render", render, workspace, cpu, estMinutes, risk,
    // requirements.mjs: an explicit vramGb wins; 0 means no GPU is needed.
    vramGb: gpu ? (gpu.minVramGb ?? 12) : 0,
    ...(maxMinutes ? { maxMinutes } : {}),
  };
}

/** Runs a render job on a node through the compute manager, with the node provider's wait as `execute`. */
export function runNodeRender({ manager, provider, tenantId, taskId, job }) {
  return manager.runJob({
    tenantId, taskId, job,
    execute: ({ instance, heartbeat, signal }) => provider.awaitJob(instance.id, { heartbeat, signal }),
  });
}
