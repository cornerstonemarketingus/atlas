/** Server-only HTTPS bridge to a deployment-owned Genesis node. Never accept a caller URL/token. */
export function genesisBridge(environment, { owner = false, fetchImpl = fetch } = {}) {
  let base;
  try { base = new URL(environment.ATLAS_GENESIS_URL); } catch { /* unavailable */ }
  const reason = !owner ? "owner_required" : !base || !environment.ATLAS_GENESIS_TOKEN ? "execution_node_not_configured"
    : base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/" ? "invalid_execution_node" : null;
  const unavailable = { github: { connected: false, canReadRepositories: false, canCreateRepositories: false, canPush: false, reason }, publish: { policy: "unavailable" } };
  async function call(path, input) {
    if (reason) return { status: "unavailable", capabilities: unavailable, message: `New project creation unavailable: ${reason}. Connect a trusted Genesis node; selected-repository dispatch cannot create projects.` };
    try {
      const response = await fetchImpl(new URL(path, base), { method: input ? "POST" : "GET", redirect: "error",
        headers: { authorization: `Bearer ${environment.ATLAS_GENESIS_TOKEN}`, "content-type": "application/json" },
        ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        if (response.status === 404 && path.startsWith("/v1/genesis/operations/")) return { status: "not-found", message: "The node has no receipt for this operation. Creation is unconfirmed; checking status never resubmits it." };
        if ([400, 409].includes(response.status)) {
          const failure = await response.json().catch(() => ({}));
          if (["INVALID_PROJECT", "REQUEST_CONFLICT"].includes(failure.code)) return { status: "failed", code: failure.code, message: failure.message };
        }
        return { status: "unavailable", message: `Genesis answered ${response.status}. Check node authentication and configuration.` };
      }
      return await response.json();
    } catch { return { status: "unavailable", message: "The Genesis execution node could not be reached. No completion is confirmed." }; }
  }
  return {
    capabilities: async ({ visibility = "private" } = {}) => {
      if (reason) return unavailable;
      const result = await call(`/v1/genesis/capabilities?visibility=${visibility === "public" ? "public" : "private"}`);
      return result.github ? result : { ...unavailable, github: { ...unavailable.github, reason: "host_unavailable" } };
    },
    create: async (input) => {
      const result = await call("/v1/genesis/operations", input);
      return reason ? result : { ...result, operationId: result.operationId ?? input?.requestId ?? null };
    },
    status: (id) => /^[a-zA-Z0-9_-]{16,100}$/u.test(id ?? "") ? call(`/v1/genesis/operations/${id}`) : Promise.resolve({ status: "not-found", message: "Invalid operation id." }),
  };
}
