import { createReadStream } from "node:fs";

import { NodeError } from "./service.mjs";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_WAIT_MS = 25_000;
export const LOCAL_OWNER_ID = "local-owner";

const STATUS_BY_CODE = Object.freeze({
  NOT_OWNER: 403, NODE_NOT_FOUND: 404, JOB_NOT_FOUND: 404, INPUT_NOT_FOUND: 404, WORKER_NOT_FOUND: 404,
  CLAIM_LOST: 409, NODE_REVOKED: 409, NODE_NOT_CONNECTED: 409, ILLEGAL_TRUST_TRANSITION: 409, CAPABILITY_GROWTH: 409,
  NODE_NOT_REGISTERED: 409, WORKER_REVOKED: 401, DIGEST_MISMATCH: 422, CONTENT_MISMATCH: 422, OUTPUT_MISSING: 422,
  OUTPUT_TOO_LARGE: 413, TOO_LARGE: 413,
});

async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new NodeError("BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new NodeError("INVALID_JSON", "The body must be JSON."); }
}

function bearer(header) {
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
}

/**
 * HTTP for Atlas Nodes.
 *
 * Node routes (`/v1/node/...`) authenticate with the node's own token, never
 * the owner's or a paired device's, and are answered before the daemon's
 * general authentication. A node token reaches nothing else.
 *   POST /v1/node/register              { capabilities, load } -> node (untrusted until approved)
 *   POST /v1/node/heartbeat             { capabilities?, load } -> extends the node's claims
 *   POST /v1/node/claim                 { waitMs } long-poll -> { job } | { job: null, reason }
 *   GET  /v1/node/jobs/:id/inputs/:n    ?claim=  -> bytes (x-atlas-sha256)
 *   POST /v1/node/jobs/:id/status       { claimId, progress, message }
 *   PUT  /v1/node/jobs/:id/outputs      ?claim=&path=  x-atlas-sha256, raw bytes
 *   POST /v1/node/jobs/:id/complete     { claimId, files: [{ path, sha256 }] }
 *   POST /v1/node/jobs/:id/fail         { claimId, error, retryable }
 *
 * Owner routes (`/v1/nodes...`), owner token on this computer only:
 *   GET  /v1/nodes, POST /v1/nodes { name } -> { node, nodeToken } (shown once),
 *   POST /v1/nodes/:id/approve, POST /v1/nodes/:id/revoke { reason }, GET /v1/nodes/jobs
 */
export function createNodeRoutes({ service, tenantFor = () => "local", send, limiter = null, limits = null }) {
  const fail = (response, error) => {
    const code = error?.code ?? "INTERNAL";
    const status = STATUS_BY_CODE[code] ?? (error instanceof NodeError || error?.name === "WorkerRegistryError" || error?.name === "RenderPolicyError" || error?.name === "ArtifactError" ? 400 : 500);
    return send(response, status, { code, message: status === 500 ? "The node request failed unexpectedly." : error.message });
  };

  async function handleNode(request, response) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/node/")) return false;
    const credential = service.authenticate(bearer(request.headers.authorization));
    if (!credential) {
      // Failed node authentication is limited per client, like pairing.
      const verdict = limiter && limits ? limiter.check({ bucket: "node-auth", client: request.socket.remoteAddress ?? "unknown", ...limits }) : null;
      if (verdict && !verdict.allowed) {
        response.setHeader("retry-after", String(verdict.retryAfterSeconds));
        return send(response, 429, { message: "Too many failed node requests. Try again shortly." });
      }
      return send(response, 401, { code: "NODE_UNAUTHORIZED", message: "A valid, unrevoked Atlas Node token is required." });
    }
    try {
      if (request.method === "POST" && url.pathname === "/v1/node/register") {
        const body = await readJson(request);
        return send(response, 200, service.register(credential, { capabilities: body.capabilities, load: body.load ?? 0 }));
      }
      if (request.method === "POST" && url.pathname === "/v1/node/heartbeat") {
        const body = await readJson(request);
        return send(response, 200, service.heartbeat(credential, { capabilities: body.capabilities, load: body.load ?? 0 }));
      }
      if (request.method === "POST" && url.pathname === "/v1/node/claim") {
        const body = await readJson(request);
        const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Number(body.waitMs) || 0));
        const deadline = Date.now() + waitMs;
        const closed = new AbortController();
        response.on("close", () => closed.abort());
        for (;;) {
          // A node that went away is never handed a job it cannot receive.
          if (closed.signal.aborted) return true;
          const fresh = service.authenticate(bearer(request.headers.authorization));
          if (!fresh) return send(response, 401, { code: "NODE_UNAUTHORIZED", message: "This node was revoked." });
          const job = service.claim(fresh);
          if (job) return send(response, 200, { job });
          const remaining = deadline - Date.now();
          if (remaining <= 0) return send(response, 200, { job: null, reason: service.claimRefusal(fresh) });
          await service.waitForWork(fresh.tenantId, Math.min(remaining, 1_000), closed.signal);
        }
      }
      const match = /^\/v1\/node\/jobs\/([A-Za-z0-9_]{1,80})\/(inputs\/(\d{1,6})|status|outputs|complete|fail)$/u.exec(url.pathname);
      if (!match) return send(response, 404, { message: "Unknown node route." });
      const [, jobId, action, inputIndex] = match;
      if (inputIndex !== undefined && request.method === "GET") {
        const input = service.inputFor(credential, jobId, Number(inputIndex), url.searchParams.get("claim"));
        response.setHeader("content-type", "application/octet-stream");
        response.setHeader("content-length", String(input.bytes));
        response.setHeader("x-atlas-sha256", input.sha256);
        response.writeHead(200);
        createReadStream(input.file).pipe(response);
        return true;
      }
      if (action === "outputs" && request.method === "PUT") {
        const length = Number(request.headers["content-length"] ?? request.headers["x-atlas-bytes"] ?? Number.NaN);
        const stored = await service.uploadOutput(credential, jobId, {
          claimId: url.searchParams.get("claim"), path: url.searchParams.get("path"), sha256: request.headers["x-atlas-sha256"],
          stream: request, declaredBytes: Number.isFinite(length) ? length : null,
        });
        return send(response, 201, { output: stored });
      }
      if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
      const body = await readJson(request);
      if (action === "status") return send(response, 200, service.reportStatus(credential, jobId, body));
      if (action === "complete") return send(response, 200, { job: summarizeJob(service.complete(credential, jobId, body)) });
      if (action === "fail") return send(response, 200, { job: summarizeJob(service.fail(credential, jobId, body)) });
      return send(response, 404, { message: "Unknown node route." });
    } catch (error) {
      // An upload refused mid-stream: drain nothing more, tell the node why.
      if (!response.headersSent) return fail(response, error);
      response.destroy();
      return true;
    }
  }

  async function handleOwner(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (url.pathname !== "/v1/nodes" && !url.pathname.startsWith("/v1/nodes/")) return false;
    if (identity?.role !== "admin") return send(response, 403, { message: "Only the owner on this computer can manage Atlas Nodes." });
    const tenantId = tenantFor(identity);
    try {
      if (request.method === "GET" && url.pathname === "/v1/nodes") return send(response, 200, { nodes: service.listNodes(tenantId) });
      if (request.method === "GET" && url.pathname === "/v1/nodes/jobs") return send(response, 200, { jobs: service.listJobs(tenantId).map(summarizeJob) });
      if (request.method === "POST" && url.pathname === "/v1/nodes") {
        const body = await readJson(request);
        const { node, token } = service.createNode({ tenantId, name: body.name, by: LOCAL_OWNER_ID });
        return send(response, 201, { node, nodeToken: token, note: "Shown once. Start the node with this token in ATLAS_NODE_TOKEN, then approve it here." });
      }
      const match = /^\/v1\/nodes\/(node_[0-9a-f]{32})\/(approve|revoke)$/u.exec(url.pathname);
      if (match && request.method === "POST") {
        const body = await readJson(request);
        const node = match[2] === "approve"
          ? service.approve(tenantId, match[1], { approver: LOCAL_OWNER_ID })
          : service.revoke(tenantId, match[1], { by: LOCAL_OWNER_ID, reason: typeof body.reason === "string" ? body.reason : undefined });
        return send(response, 200, { node });
      }
      return send(response, 404, { message: "Unknown node route." });
    } catch (error) {
      return fail(response, error);
    }
  }

  return { handleNode, handleOwner };
}

function summarizeJob(job) {
  if (!job) return null;
  return {
    id: job.id, state: job.state, tool: job.render.tool, outputs: job.outputs, attempts: job.attempts, maxAttempts: job.maxAttempts,
    claimant: job.claimant, status: job.status, error: job.error, endReason: job.endReason, createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}
