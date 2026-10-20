import { ComputeManager } from "./manager.mjs";
import { RunpodProvider } from "./runpod.mjs";

/**
 * Builds the daemon's compute service from configuration. Off by default:
 *
 *  - no ATLAS_RUNPOD_ENDPOINT_ID          -> nothing is constructed, no network
 *  - endpoint but no ATLAS_RUNPOD_API_KEY  -> nothing is constructed
 *  - endpoint + key, cap 0 (the default)  -> the manager and reconciler run so
 *    any Atlas job left from an earlier run is cancelled, but every provision
 *    is refused (GPU_SPENDING_OFF)
 *  - endpoint + key + ATLAS_GPU_MONTHLY_CAP_USD > 0 -> GPU jobs may run
 *
 * The key is read through `credentials(name)` (vault first, then env) only
 * when a request needs it, and is never returned or logged.
 *
 * Settings: ATLAS_RUNPOD_ENDPOINT_ID, ATLAS_RUNPOD_API_KEY (secret),
 * ATLAS_GPU_MONTHLY_CAP_USD, ATLAS_RUNPOD_GPU_TYPES (comma-separated pool
 * ids, default AMPERE_24), ATLAS_RUNPOD_PRICING (JSON price overrides),
 * ATLAS_RUNPOD_IDLE_TIMEOUT_SEC (match the endpoint, default 5),
 * ATLAS_RUNPOD_COLD_START_SEC (default 60), ATLAS_RUNPOD_QUEUE_TTL_SEC
 * (default 900). See docs/atlas-os/COMPUTE.md.
 */
export const RUNPOD_API_KEY_NAME = "ATLAS_RUNPOD_API_KEY";

/** Whole USD (decimals allowed) to integer micro-USD; anything invalid or negative is 0 (spending off). */
export function parseMonthlyCapUsd(value) {
  if (value === undefined || value === null || String(value).trim() === "") return { capMicroUsd: 0, valid: true };
  const usd = Number(String(value).trim());
  if (!Number.isFinite(usd) || usd < 0) return { capMicroUsd: 0, valid: false };
  return { capMicroUsd: Math.floor(usd * 1_000_000), valid: true };
}

const intSetting = (env, name, fallback) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
};

export async function createComputeService({ env = process.env, credentials, store, leaseDb, clock = undefined, fetchImpl = globalThis.fetch }) {
  const endpointId = env.ATLAS_RUNPOD_ENDPOINT_ID?.trim();
  const cap = parseMonthlyCapUsd(env.ATLAS_GPU_MONTHLY_CAP_USD);
  if (!endpointId) return { enabled: false, reason: "ATLAS_RUNPOD_ENDPOINT_ID is not set; rented GPU compute is off." };
  if (typeof credentials !== "function") throw new Error("createComputeService needs a credentials resolver.");
  let cached = null;
  const apiKey = async () => (cached ??= (await credentials(RUNPOD_API_KEY_NAME)) || null);
  if (!(await apiKey())) return { enabled: false, reason: `${RUNPOD_API_KEY_NAME} is not in the vault or environment; rented GPU compute is off.` };
  let pricing;
  if (env.ATLAS_RUNPOD_PRICING?.trim()) {
    try { pricing = JSON.parse(env.ATLAS_RUNPOD_PRICING); } catch { throw new Error("ATLAS_RUNPOD_PRICING must be JSON."); }
  }
  const gpuTypes = (env.ATLAS_RUNPOD_GPU_TYPES?.trim() || "AMPERE_24").split(",").map(item => item.trim()).filter(Boolean);
  const provider = new RunpodProvider({
    endpointId, apiKey, gpuTypes, pricing, db: leaseDb, fetchImpl,
    ...(env.ATLAS_RUNPOD_BASE_URL?.trim() ? { baseUrl: env.ATLAS_RUNPOD_BASE_URL.trim() } : {}),
    workerIdleTimeoutSec: intSetting(env, "ATLAS_RUNPOD_IDLE_TIMEOUT_SEC", 5),
    coldStartAllowanceSec: intSetting(env, "ATLAS_RUNPOD_COLD_START_SEC", 60),
    queueTtlSec: intSetting(env, "ATLAS_RUNPOD_QUEUE_TTL_SEC", 900) || 900,
    ...(clock ? { clock } : {}),
  });
  const manager = new ComputeManager({ store, leaseDb, providers: [provider], monthlyCapMicroUsd: cap.capMicroUsd, ...(clock ? { clock } : {}) });
  const provisioning = cap.capMicroUsd > 0;
  return {
    enabled: true, provisioning, manager, provider, capMicroUsd: cap.capMicroUsd,
    /** Stops the reconciler and releases both database handles. */
    close() { manager.stopReconciler(); manager.leases.close(); provider.close(); },
    reason: provisioning
      ? `RunPod endpoint configured; GPU spend capped at ${cap.capMicroUsd / 1_000_000} USD per month.`
      : `RunPod endpoint configured but ATLAS_GPU_MONTHLY_CAP_USD is ${cap.valid ? "0" : "invalid"}: GPU spending is off (the reconciler still cleans up).`,
  };
}
