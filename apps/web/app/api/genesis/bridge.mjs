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
    if (reason) return { status: "unavailable", capabilities: unavailable, message: `New project creation unavailable: ${reason}. Connect a trusted Genesis node; selected-repository dispatch cannot create projects.` };
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
            return { status: "unavailable", message: `Genesis answered ${response.status}. Check node authentication and configuration.` };
          }
          return await response.json();
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Genesis deadline exceeded")); }, timeoutMs); }),
      ]);
    } catch { return { status: "unavailable", message: "The Genesis execution node could not be reached. No completion is confirmed." }; }
    finally { clearTimeout(timer); }
  }
  return {
    capabilities: async ({ visibility = "private" } = {}) => {
      if (reason) return unavailable;
      const result = await call(`/v1/genesis/capabilities?visibility=${visibility === "public" ? "public" : "private"}`, undefined, capabilityTimeoutMs);
      return result.github ? result : { ...unavailable, github: { ...unavailable.github, reason: "host_unavailable" } };
    },
    create: async (input) => {
      const result = await call("/v1/genesis/operations", input);
      return reason ? result : { ...result, operationId: result.operationId ?? input?.requestId ?? null };
    },
    status: (id) => /^[a-zA-Z0-9_-]{16,100}$/u.test(id ?? "") ? call(`/v1/genesis/operations/${id}`) : Promise.resolve({ status: "not-found", message: "Invalid operation id." }),
  };
}
