/**
 * GET /v1/compute — what rented GPU compute and the owner's Atlas Nodes are
 * doing, and what GPUs have cost this month (owner only; a paired device gets
 * 403, as with renders).
 *
 * The summary is built from an allowlist of fields. The service object holds
 * the RunPod provider, whose API key is resolved through the vault on demand;
 * none of that, nor an instance id or a node token, is ever copied into the
 * response.
 *
 * `gpuSpending` is true only when a paid provider (RunPod) is configured and
 * the monthly cap is above 0. `capMicroUsd` is the cap that applies to paid
 * GPUs: 0 when no paid provider is configured, since nothing can be spent.
 * Atlas Nodes cost $0 and can run while GPU spending is off.
 */
export const RECENT_LEASES = 20;

const LEASE_FIELDS = Object.freeze([
  "id", "jobId", "taskId", "provider", "gpuType", "state", "reservedMicroUsd", "actualMicroUsd",
  "rateMicroUsdPerSec", "maxLifetimeSec", "createdAt", "endedAt", "endReason",
]);

const pick = (lease) => Object.fromEntries(LEASE_FIELDS.map((field) => [field, lease[field] ?? null]));

/** Counts of the tenant's Atlas Nodes: all not revoked, approved by the owner, and online (fresh heartbeat). */
export function nodeSummary(nodes, tenantId) {
  if (!nodes) return null;
  const list = nodes.listNodes(tenantId).filter((node) => node && !node.revoked);
  return {
    count: list.length,
    approved: list.filter((node) => node.status === "approved").length,
    online: list.filter((node) => node.status === "approved" && node.worker?.availability?.available === true).length,
  };
}

/** The owner-facing compute summary; `compute` is what createComputeService returned (or null). */
export function computeSummary(compute, tenantId, { nodes = null } = {}) {
  const nodeCounts = nodeSummary(nodes, tenantId);
  if (!compute?.enabled) {
    return {
      enabled: false, provisioning: false, rented: false, gpuSpending: false,
      reason: compute?.reason ?? "Rented GPU compute is not configured in this process.",
      capMicroUsd: 0, spend: null, leases: [], nodes: nodeCounts,
    };
  }
  const spend = compute.manager.monthlySpend(tenantId);
  const rented = Boolean(compute.provider);
  const capMicroUsd = rented ? spend.capMicroUsd : 0;
  const leases = compute.manager.listLeases(tenantId).slice(-RECENT_LEASES).reverse().map(pick);
  return {
    enabled: true,
    provisioning: compute.provisioning === true,
    rented,
    gpuSpending: rented && capMicroUsd > 0,
    reason: compute.reason,
    capMicroUsd,
    spend: {
      month: spend.month,
      settledMicroUsd: spend.settledMicroUsd,
      reservedMicroUsd: spend.reservedMicroUsd,
      totalMicroUsd: spend.totalMicroUsd,
      remainingMicroUsd: rented ? spend.remainingMicroUsd : 0,
    },
    leases,
    nodes: nodeCounts,
  };
}

export function createComputeRoutes({ compute, nodes = null, tenantFor = () => "local", send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (url.pathname !== "/v1/compute") return false;
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      return send(response, 405, { message: "Compute status is read with GET." });
    }
    if (identity?.role !== "admin") return send(response, 403, { message: "Only the owner on this computer can see GPU compute and spend." });
    try {
      return send(response, 200, { compute: computeSummary(compute, tenantFor(identity), { nodes }) });
    } catch {
      return send(response, 500, { message: "Compute status could not be read." });
    }
  };
}
