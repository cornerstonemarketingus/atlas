/**
 * GET /v1/compute — what rented GPU compute is doing and what it has cost
 * this month (owner only; a paired device gets 403, as with renders).
 *
 * The summary is built from an allowlist of fields. The service object holds
 * the provider, whose API key is resolved through the vault on demand; none
 * of that, nor an instance id, is ever copied into the response.
 */
export const RECENT_LEASES = 20;

const LEASE_FIELDS = Object.freeze([
  "id", "jobId", "taskId", "provider", "gpuType", "state", "reservedMicroUsd", "actualMicroUsd",
  "rateMicroUsdPerSec", "maxLifetimeSec", "createdAt", "endedAt", "endReason",
]);

const pick = (lease) => Object.fromEntries(LEASE_FIELDS.map((field) => [field, lease[field] ?? null]));

/** The owner-facing compute summary; `compute` is what createComputeService returned (or null). */
export function computeSummary(compute, tenantId) {
  if (!compute?.enabled) {
    return {
      enabled: false,
      provisioning: false,
      reason: compute?.reason ?? "Rented GPU compute is not configured in this process.",
      capMicroUsd: 0,
      spend: null,
      leases: [],
    };
  }
  const spend = compute.manager.monthlySpend(tenantId);
  const leases = compute.manager.listLeases(tenantId).slice(-RECENT_LEASES).reverse().map(pick);
  return {
    enabled: true,
    provisioning: compute.provisioning === true,
    reason: compute.reason,
    capMicroUsd: spend.capMicroUsd,
    spend: {
      month: spend.month,
      settledMicroUsd: spend.settledMicroUsd,
      reservedMicroUsd: spend.reservedMicroUsd,
      totalMicroUsd: spend.totalMicroUsd,
      remainingMicroUsd: spend.remainingMicroUsd,
    },
    leases,
  };
}

export function createComputeRoutes({ compute, tenantFor = () => "local", send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (url.pathname !== "/v1/compute") return false;
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      return send(response, 405, { message: "Compute status is read with GET." });
    }
    if (identity?.role !== "admin") return send(response, 403, { message: "Only the owner on this computer can see GPU compute and spend." });
    try {
      return send(response, 200, { compute: computeSummary(compute, tenantFor(identity)) });
    } catch {
      return send(response, 500, { message: "Compute status could not be read." });
    }
  };
}
