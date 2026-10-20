import { RenderError } from "./render-runner.mjs";

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RenderError("INVALID_JOB", "The render job is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new RenderError("INVALID_JOB", "The render job must be JSON."); }
}

/**
 * HTTP for the render runner.
 * - GET  /v1/render       what this machine can render (status, never secrets).
 * - POST /v1/render/jobs  owner only: { projectId, job } renders inside the
 *   container sandbox against that Genesis project's workspace; video outputs
 *   land in the artifact store with the project as provenance.
 * Paired devices cannot start renders: a render is execution on this computer.
 */
export function createRenderRoutes({ render, genesis = null, tenantFor = () => "local", send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (url.pathname !== "/v1/render" && !url.pathname.startsWith("/v1/render/")) return false;
    if (request.method === "GET" && url.pathname === "/v1/render") return send(response, 200, { render: render.status() });
    if (url.pathname !== "/v1/render/jobs") return send(response, 404, { message: "Unknown render route." });
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { message: "Render jobs are started with POST." });
    }
    if (identity?.role !== "admin") return send(response, 403, { message: "Only the owner on this computer can start a render." });
    if (!genesis) return send(response, 503, { message: "Project Genesis is not running in this process." });
    let body;
    try { body = await readJson(request); } catch (error) { return send(response, 400, { code: error.code, message: error.message }); }
    if (typeof body.projectId !== "string" || !body.projectId) return send(response, 400, { code: "INVALID_JOB", message: "projectId is required." });
    let project;
    try { project = genesis.view(body.projectId); } catch { project = null; }
    if (!project) return send(response, 404, { message: "Project not found." });
    if (!project.workspace) return send(response, 409, { code: "NO_WORKSPACE", message: "The project has no workspace yet." });
    try {
      const result = await render.run(project.workspace, body.job, { tenantId: tenantFor(identity), runId: project.id });
      return send(response, result.ok ? 200 : 422, { result });
    } catch (error) {
      if (error instanceof RenderError) {
        const status = error.code === "REQUIRES_CONTAINER_SANDBOX" || error.code === "IMAGE_NOT_CONFIGURED" ? 503 : 400;
        return send(response, status, { code: error.code, message: error.message });
      }
      return send(response, 500, { message: "The render failed unexpectedly." });
    }
  };
}
