/**
 * Why project creation is unavailable and what fixes it. Fixed copy only: it never repeats
 * a URL, token or provider response, so it is safe to show to the person who asked.
 */
export const UNAVAILABLE_NEXT_STEPS = Object.freeze({
  owner_required: "This shared Genesis execution node is limited to the deployment owner. Sign in to your workspace to build a hosted website; apps and repository publishing require an authorized execution node.",
  execution_node_not_configured: "No Genesis execution node is connected to this deployment. The owner must set the ATLAS_GENESIS_URL (an https origin) and ATLAS_GENESIS_TOKEN secrets and run \"Deploy Atlas web to Cloudflare Workers\".",
  invalid_execution_node: "ATLAS_GENESIS_URL must be a plain https origin with no path, query or credentials. Fix the secret and redeploy.",
  node_rejected_token: "The Genesis node refused this deployment's token. Rotate ATLAS_GENESIS_TOKEN on the node and in the repository secrets, then redeploy.",
  node_error: "The Genesis node answered with an error. Check its logs and health, then try again.",
  node_unreachable: "The Genesis node could not be reached. Check that it is running and reachable over https, then try again.",
  node_timeout: "The Genesis node did not answer in time. Check that it is running, then try again. No completion is confirmed.",
});
const unavailableResult = (reason, extra = {}) => ({ status: "unavailable", reason, nextStep: UNAVAILABLE_NEXT_STEPS[reason] ?? null, ...extra });

/** Read-only preflight must not consume an operation's full execution timeout. */
export const CAPABILITIES_TIMEOUT_MS = 1500;
/** Server-only HTTPS bridge to a deployment-owned Genesis node. Never accept a caller URL/token. */
export function genesisBridge(environment, { owner = false, fetchImpl = fetch, capabilityTimeoutMs = CAPABILITIES_TIMEOUT_MS } = {}) {
  if (!Number.isFinite(capabilityTimeoutMs) || capabilityTimeoutMs <= 0 || capabilityTimeoutMs > 15000) throw new TypeError("Invalid capability timeout.");
  let base;
  try { base = new URL(environment.ATLAS_GENESIS_URL); } catch { /* unavailable */ }
  const reason = !owner ? "owner_required" : !base || !environment.ATLAS_GENESIS_TOKEN ? "execution_node_not_configured"
    : base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/" ? "invalid_execution_node" : null;
  const unavailable = { github: { connected: false, canReadRepositories: false, canCreateRepositories: false, canPush: false, reason }, publish: { policy: "unavailable" } };
  async function call(path, input, timeoutMs = 15000) {
    if (reason) return unavailableResult(reason, { capabilities: unavailable, message: `New project creation unavailable: ${reason}. Connect a trusted Genesis node; selected-repository dispatch cannot create projects.` });
    const controller = new AbortController();
    let timer;
    try {
      // Bound both headers and JSON parsing, including fetch implementations
      // that do not settle their promise when a signal is aborted.
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(new URL(path, base), { method: input ? "POST" : "GET", redirect: "manual",
            headers: { authorization: `Bearer ${environment.ATLAS_GENESIS_TOKEN}`, "content-type": "application/json" },
            ...(input ? { body: JSON.stringify(input) } : {}), signal: controller.signal });
          if (!response.ok) {
            if ([400, 409].includes(response.status)) {
              const failure = await response.json().catch(() => ({}));
              if (["INVALID_PROJECT", "REQUEST_CONFLICT"].includes(failure.code)) return { status: "failed", code: failure.code, message: failure.message };
            }
            return unavailableResult([401, 403].includes(response.status) ? "node_rejected_token" : "node_error", { message: `Genesis answered ${response.status}. Check node authentication and configuration.` });
          }
          return await response.json();
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Genesis deadline exceeded")); }, timeoutMs); }),
      ]);
    } catch (error) {
      return unavailableResult(error?.message === "Genesis deadline exceeded" ? "node_timeout" : "node_unreachable", { message: "The Genesis execution node could not be reached. No completion is confirmed." });
    }
    finally { clearTimeout(timer); }
  }
  return {
    /** False when no node can be asked at all (not the owner, or not configured); the hosted builder is used instead. */
    available: reason === null,
    capabilities: async ({ visibility = "private" } = {}) => {
      if (reason) return unavailable;
      const result = await call(`/v1/genesis/capabilities?visibility=${visibility === "public" ? "public" : "private"}`, undefined, capabilityTimeoutMs);
      return result.github ? result : { ...unavailable, github: { ...unavailable.github, reason: "host_unavailable" } };
    },
    create: async (input) => {
      const result = await call("/v1/genesis/operations", input);
      // A receipt id exists only for an operation the node accepted; an unavailable or refused request has none.
      return reason || ["unavailable", "failed", "denied"].includes(result.status) ? result : { ...result, operationId: result.operationId ?? input?.requestId ?? null };
    },
    status: (id) => /^[a-zA-Z0-9_-]{16,100}$/u.test(id ?? "") ? call(`/v1/genesis/operations/${id}`) : Promise.resolve({ status: "not-found", message: "Invalid operation id." }),
  };
}
