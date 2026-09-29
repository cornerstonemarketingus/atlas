/**
 * /v1/world — Atlas's world state, owner only (it names files, pages, people
 * and runs on this machine).
 *
 * GET /v1/world?type=&limit=          recent entities (optionally one type)
 * GET /v1/world/entities/:id          one entity and its relations
 * GET /v1/world/runs/:runId/trace     a kernel run's phases, in order
 */
export function createWorldRoutes({ world, send }) {
  return function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/world")) return false;
    if (request.method !== "GET") return send(response, 405, { message: "Method not allowed." });
    if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
    if (url.pathname === "/v1/world") {
      const type = url.searchParams.get("type");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
      return send(response, 200, { entities: world.find({ type: type || null, limit }) });
    }
    const entity = /^\/v1\/world\/entities\/(.{1,600})$/u.exec(url.pathname);
    if (entity) {
      let id;
      try { id = decodeURIComponent(entity[1]); } catch { return send(response, 400, { message: "Bad entity id." }); }
      const found = world.get(id);
      return found ? send(response, 200, { entity: found, relations: world.relations(id) }) : send(response, 404, { message: "Entity not found." });
    }
    const trace = /^\/v1\/world\/runs\/(.{1,300})\/trace$/u.exec(url.pathname);
    if (trace) {
      let runId;
      try { runId = decodeURIComponent(trace[1]); } catch { return send(response, 400, { message: "Bad run id." }); }
      return send(response, 200, { runId, run: world.get(`run:${runId}`), trace: world.traceOf(runId) });
    }
    return send(response, 404, { message: "Route not found." });
  };
}
