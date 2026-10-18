import { isAbsolute } from "node:path";

import { mapRepository, RepoGraphError } from "./repo-graph.mjs";

/**
 * /v1/world — Atlas's world state, owner only (it names files, pages, people
 * and runs on this machine).
 *
 * GET /v1/world?type=&limit=          recent entities (optionally one type)
 * GET /v1/world/entities/:id          one entity and its relations
 * GET /v1/world/runs/:runId/trace     a kernel run's phases, in order
 * GET /v1/world/impact?id=&depth=     what a change to one entity affects, and the tests to run
 * POST /v1/world/map {repository}     map a repository's packages, files and imports (Track B2)
 */
export function createWorldRoutes({ world, send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/world")) return false;
    if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
    if (url.pathname === "/v1/world/map") {
      if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
      const body = await readJson(request);
      if (!body || typeof body.repository !== "string" || !isAbsolute(body.repository.trim())) return send(response, 400, { message: "Give the repository as an absolute folder path." });
      try {
        return send(response, 200, { map: mapRepository(world, body.repository.trim()) });
      } catch (error) {
        if (error instanceof RepoGraphError) return send(response, 400, { code: error.code, message: error.message });
        throw error;
      }
    }
    if (request.method !== "GET") return send(response, 405, { message: "Method not allowed." });
    if (url.pathname === "/v1/world/impact") {
      const id = url.searchParams.get("id") ?? "";
      const depth = Math.min(Math.max(Number(url.searchParams.get("depth")) || 4, 1), 8);
      const impact = id ? world.impact(id, { depth }) : null;
      return impact ? send(response, 200, impact) : send(response, 404, { message: "Entity not found." });
    }
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

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
