import { GenesisTransitionError } from "./lifecycle.mjs";
import { GenesisError } from "./service.mjs";
import { GenesisStoreError } from "./store.mjs";
import { TEMPLATES } from "./templates/index.mjs";
import { PublishError } from "./publish.mjs";

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
 * POST /v1/genesis/:id/restore         recreate the workspace from the latest verified snapshot and continue
 * GET  /v1/genesis/:id/snapshot        the latest snapshot receipt (when, digests) and how its last restore went
 * GET  /v1/genesis/:id/preview         preview state and recent logs
 * POST /v1/genesis/:id/preview         { action: "start" | "stop" } (a ready project only)
 * POST /v1/genesis/:id/publish         { remote } — goes through the publish.remote policy and approvals
 * POST /v1/genesis/:id/repository      { host, name?, visibility?, baseUrl? } — create a repository, then publish (publish.remote)
 * POST /v1/genesis/:id/deploy          { target: "preview" | "production" } — static sites to Vercel (deploy.remote)
 */
const STATUS = {
  INVALID_PROJECT: 400, REQUEST_CONFLICT: 409,
  PROMPT_REQUIRED: 400, PROMPT_TOO_LONG: 400, NOT_WAITING: 409, ANSWERS_MISSING: 400, NOT_PLANNED: 409, BUSY: 409, NOT_PAUSED: 409, NOT_FAILED: 409,
  NOT_FOUND: 404, STALE_VERSION: 409, ILLEGAL_TRANSITION: 409, REASON_REQUIRED: 400,
};

const RESTORE_HOLD_STATES = Object.freeze(["paused", "blocked"]);
const RESTORE_REBUILD_STATES = Object.freeze(["ready", "published", "failed"]);

/**
 * The latest snapshot's receipt for the console: when it was taken, at which
 * stage, its digests, and how the last restore attempt that left a record
 * went (a verified resume receipt, or a refusal such as DIGEST_MISMATCH).
 * Snapshot digests are verified when a snapshot is restored, never assumed.
 * `restorable` mirrors GenesisExecutor.resumeFromSnapshot's preconditions.
 */
export function snapshotReceipt(genesis, id, { canRestore = true } = {}) {
  const project = genesis.view(id);
  const latest = genesis.store.latestSnapshot(id);
  const snapshot = latest ? {
    id: latest.snapshot.id, seq: latest.snapshot.seq, state: latest.state, takenAt: latest.snapshot.createdAt ?? latest.createdAt,
    commit: latest.snapshot.commit, treeDigest: latest.snapshot.treeDigest, manifestDigest: latest.snapshot.manifestDigest,
    files: Array.isArray(latest.snapshot.files) ? latest.snapshot.files.length : null,
  } : null;
  const attempt = [...(project.transitions ?? [])].reverse().find((t) => ["resume-receipt", "resume-refused"].includes(t.evidence?.kind));
  const lastRestore = attempt ? {
    at: attempt.at,
    snapshot: attempt.evidence.kind === "resume-receipt" ? attempt.evidence.snapshot?.id ?? null : attempt.evidence.snapshot ?? null,
    restored: attempt.evidence.kind === "resume-receipt",
    verified: attempt.evidence.kind === "resume-receipt" && attempt.evidence.verified === true,
    code: attempt.evidence.code ?? null,
    message: attempt.evidence.message ?? null,
  } : null;
  let restorable = false, reason = null;
  if (!canRestore) reason = "Restoring projects is not available in this Atlas.";
  else if (!snapshot) reason = "no-snapshot";
  else if (RESTORE_REBUILD_STATES.includes(project.state)) restorable = true;
  else if (RESTORE_HOLD_STATES.includes(project.state)) {
    restorable = latest.state === project.resumeTo;
    if (!restorable) reason = "no-snapshot-for-stage";
  } else reason = `A ${project.state} project cannot be restored.`;
  return { projectId: project.id, state: project.state, snapshot, lastRestore, restorable, reason };
}

export function createGenesisRoutes({ genesis, executor = null, previews = null, publisher = null, creation = null, parseBody, send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/genesis")) return false;
    try {
      if (url.pathname.startsWith("/v1/genesis/operations") || url.pathname === "/v1/genesis/capabilities") {
        if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
        if (!creation || !publisher) return send(response, 503, { message: "Project creation is not configured." });
        if (request.method === "GET" && url.pathname === "/v1/genesis/capabilities") return send(response, 200, await publisher.repositoryCapabilities({ visibility: url.searchParams.get("visibility") === "public" ? "public" : "private" }));
        const operation = /^\/v1\/genesis\/operations\/([a-zA-Z0-9_-]{16,100})$/u.exec(url.pathname);
        if (request.method === "GET" && operation) return send(response, 200, creation.status(operation[1]));
        if (request.method === "POST" && url.pathname === "/v1/genesis/operations") {
          const body = await parseBody(request, response); if (!body) return true;
          return send(response, 202, await creation.create(body));
        }
        return send(response, 404, { message: "Route not found." });
      }
      if (request.method === "GET" && url.pathname === "/v1/genesis") return send(response, 200, { projects: genesis.list() });
      if (request.method === "GET" && url.pathname === "/v1/genesis/templates") {
        return send(response, 200, { templates: Object.values(TEMPLATES).map(({ id, version, title, description, archetypes, commands, preview, structure }) => ({ id, version, title, description, archetypes, commands, preview, structure })) });
      }
      const match = /^\/v1\/genesis\/(gen_[0-9a-f-]{36})(?:\/(answers|approve|changes|pause|resume|cancel|retry|restore|snapshot|preview|publish|repository|deploy))?$/u.exec(url.pathname);
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
      if (match?.[2] === "snapshot") {
        // Read-only: never let a POST here reach the action chain below.
        if (request.method !== "GET") return send(response, 405, { message: "The snapshot receipt is read with GET; restore with POST /restore." });
        return send(response, 200, snapshotReceipt(genesis, match[1], { canRestore: Boolean(executor) }));
      }
      if (request.method === "GET" && match && !match[2]) return send(response, 200, { project: genesis.view(match[1]) });
      if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required.", unblock: "Use the local owner token." });
      const body = await parseBody(request, response); if (!body) return true;
      if (url.pathname === "/v1/genesis") return send(response, 201, { project: await genesis.create(body.prompt) });
      if (!match || !match[2]) return send(response, 404, { message: "Route not found." });
      if (["publish", "repository", "deploy"].includes(match[2])) {
        if (!publisher) return send(response, 503, { message: "Publishing is not available in this Atlas." });
        const result = match[2] === "publish" ? await publisher.request(match[1], { remote: body.remote })
          : match[2] === "repository" ? await publisher.requestRepository(match[1], { host: body.host, name: body.name || null, visibility: body.visibility, baseUrl: body.baseUrl || null })
            : await publisher.requestDeployment(match[1], { target: body.target });
        return send(response, result.status === "awaiting-approval" ? 202 : ["published", "deployed"].includes(result.status) ? 200 : 502, { publish: result, project: genesis.view(match[1]) });
      }
      const [, id, action] = match;
      if (action === "restore") {
        if (!executor) return send(response, 503, { message: "Restoring projects is not available in this Atlas." });
        const receipt = await executor.resumeFromSnapshot(id, { actor: "owner" });
        return send(response, receipt.restored ? 200 : 409, { restore: receipt, project: genesis.view(id) });
      }
      const result = action === "answers" ? await genesis.answer(id, body.answers)
        : action === "approve" ? genesis.approve(id)
          : action === "changes" ? await genesis.change(id, body.request)
            : action === "pause" ? genesis.view(genesis.pause(id).id)
              : action === "resume" ? genesis.view(genesis.resume(id).id)
                : action === "retry" ? genesis.view(genesis.retry(id).id)
                : genesis.view(genesis.cancel(id).id);
      return send(response, 200, { project: result });
    } catch (error) {
      if (error instanceof PublishError) return send(response, error.code === "DENIED_BY_POLICY" ? 403 : ["NOT_READY", "NEEDS_SERVER", "EXISTS", "NO_CREDENTIAL"].includes(error.code) ? 409 : 400, { code: error.code, message: error.message });
      if (error instanceof GenesisError || error instanceof GenesisStoreError || error instanceof GenesisTransitionError) {
        return send(response, STATUS[error.code] ?? 400, { code: error.code, message: error.message });
      }
      return send(response, 500, { message: error instanceof Error ? error.message : "The request failed." });
    }
  };
}
