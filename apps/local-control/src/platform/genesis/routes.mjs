import { GenesisTransitionError } from "./lifecycle.mjs";
import { GenesisError } from "./service.mjs";
import { GenesisStoreError } from "./store.mjs";
import { TEMPLATES } from "./templates/index.mjs";

/**
 * /v1/genesis — any authenticated caller can read; creating and steering
 * projects needs the owner.
 *
 * GET  /v1/genesis                     projects
 * GET  /v1/genesis/templates           curated templates (id, version, commands, structure)
 * GET  /v1/genesis/:id                 project, spec, plan, tasks, transitions, progress
 * POST /v1/genesis                     { prompt }
 * POST /v1/genesis/:id/answers         { answers: { id: text } }
 * POST /v1/genesis/:id/approve
 * POST /v1/genesis/:id/changes         { request }
 * POST /v1/genesis/:id/pause | resume | cancel | retry
 * GET  /v1/genesis/:id/preview         preview state and recent logs
 * POST /v1/genesis/:id/preview         { action: "start" | "stop" } (a ready project only)
 */
const STATUS = {
  PROMPT_REQUIRED: 400, PROMPT_TOO_LONG: 400, NOT_WAITING: 409, ANSWERS_MISSING: 400, NOT_PLANNED: 409, BUSY: 409, NOT_PAUSED: 409, NOT_FAILED: 409,
  NOT_FOUND: 404, STALE_VERSION: 409, ILLEGAL_TRANSITION: 409, REASON_REQUIRED: 400,
};

export function createGenesisRoutes({ genesis, previews = null, parseBody, send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/genesis")) return false;
    try {
      if (request.method === "GET" && url.pathname === "/v1/genesis") return send(response, 200, { projects: genesis.list() });
      if (request.method === "GET" && url.pathname === "/v1/genesis/templates") {
        return send(response, 200, { templates: Object.values(TEMPLATES).map(({ id, version, title, description, archetypes, commands, preview, structure }) => ({ id, version, title, description, archetypes, commands, preview, structure })) });
      }
      const match = /^\/v1\/genesis\/(gen_[0-9a-f-]{36})(?:\/(answers|approve|changes|pause|resume|cancel|retry|preview))?$/u.exec(url.pathname);
      if (match?.[2] === "preview") {
        if (!previews) return send(response, 503, { message: "Previews are not available in this Atlas." });
        const project = genesis.store.get(genesis.tenantId, match[1]);
        if (request.method === "GET") return send(response, 200, { preview: previews.status(project.id) });
        if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
        if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
        const body = await parseBody(request, response); if (!body) return true;
        if (body.action === "stop") return send(response, 200, { stopped: await previews.stop(project.id) });
        if (!["ready", "published"].includes(project.state)) return send(response, 409, { message: "Atlas starts the preview itself while building; open it again once the project is ready." });
        const started = await previews.start(project);
        return send(response, started.ok ? 200 : 502, { preview: started });
      }
      if (request.method === "GET" && match && !match[2]) return send(response, 200, { project: genesis.view(match[1]) });
      if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required.", unblock: "Use the local owner token." });
      const body = await parseBody(request, response); if (!body) return true;
      if (url.pathname === "/v1/genesis") return send(response, 201, { project: await genesis.create(body.prompt) });
      if (!match || !match[2]) return send(response, 404, { message: "Route not found." });
      const [, id, action] = match;
      const result = action === "answers" ? await genesis.answer(id, body.answers)
        : action === "approve" ? genesis.approve(id)
          : action === "changes" ? await genesis.change(id, body.request)
            : action === "pause" ? genesis.view(genesis.pause(id).id)
              : action === "resume" ? genesis.view(genesis.resume(id).id)
                : action === "retry" ? genesis.view(genesis.retry(id).id)
                : genesis.view(genesis.cancel(id).id);
      return send(response, 200, { project: result });
    } catch (error) {
      if (error instanceof GenesisError || error instanceof GenesisStoreError || error instanceof GenesisTransitionError) {
        return send(response, STATUS[error.code] ?? 400, { code: error.code, message: error.message });
      }
      return send(response, 500, { message: error instanceof Error ? error.message : "The request failed." });
    }
  };
}
