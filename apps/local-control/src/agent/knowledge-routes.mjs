/**
 * Knowledge (scoped memory) and connections (MCP servers) on the local
 * control plane. The owner reads memory as `user:local-owner`, which sees
 * entries that name the owner as a reader; agents read their family's memory
 * through the step executor, never through this route. Deleting is owner-only
 * and erases the whole version lineage.
 */
const TENANT = "local";
const OWNER = { userId: "local-owner" };
const ENTRY_ID = "[A-Za-z0-9_-]{8,80}";

export function createKnowledgeRoutes({ memory, connections = () => [], send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (url.pathname === "/v1/connections" && request.method === "GET") {
      return send(response, 200, { mcp: connections() });
    }
    if (url.pathname !== "/v1/knowledge" && !url.pathname.startsWith("/v1/knowledge/")) return false;
    if (!memory) return send(response, 503, { message: "Knowledge is not running in this process.", blocked: "BLOCKED_BY_DEPENDENCY" });
    try {
      if (request.method === "GET" && url.pathname === "/v1/knowledge") {
        const query = (url.searchParams.get("q") ?? "").slice(0, 500);
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        return send(response, 200, { searchMode: memory.searchMode, entries: memory.retrieve(TENANT, OWNER, { query, limit }) });
      }
      const history = request.method === "GET" ? new RegExp(`^/v1/knowledge/(${ENTRY_ID})/history$`, "u").exec(url.pathname) : null;
      if (history) return send(response, 200, { versions: memory.history(TENANT, OWNER, history[1]) });
      const one = new RegExp(`^/v1/knowledge/(${ENTRY_ID})$`, "u").exec(url.pathname);
      if (one && request.method === "GET") {
        const entry = memory.get(TENANT, OWNER, one[1]);
        return entry ? send(response, 200, { entry }) : send(response, 404, { code: "NOT_FOUND", message: "No such knowledge entry." });
      }
      if (one && request.method === "DELETE") {
        if (identity.role !== "admin") return send(response, 403, { message: "Owner access required.", blocked: "BLOCKED_BY_PERMISSION", unblock: "Use the local owner token." });
        // Only entries the owner can see can be deleted from here.
        if (!memory.get(TENANT, OWNER, one[1])) return send(response, 404, { code: "NOT_FOUND", message: "No such knowledge entry." });
        return send(response, 200, memory.delete(one[1], { tenantId: TENANT, by: "local-owner", reason: "deleted by the owner" }));
      }
      return send(response, 404, { message: "Route not found." });
    } catch (error) {
      return send(response, error.code === "NOT_FOUND" ? 404 : 500, { code: error.code ?? "ERROR", message: error.message ?? "The request failed." });
    }
  };
}
