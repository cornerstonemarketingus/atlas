import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { LOCAL_UI_CSS, LOCAL_UI_HTML, LOCAL_UI_ICON, LOCAL_UI_JS } from "./ui.mjs";
import { decryptBackup, encryptBackup } from "./encrypted-backup.mjs";
import { publishChange } from "./publish-adapters.mjs";
import { discoverLocalModels } from "./model-discovery.mjs";
import { createAgentRoutes } from "./agent/routes.mjs";
import { createMissionRoutes } from "./agent/mission-routes.mjs";
import { createPlatformRoutes, LOCAL_TENANT_ID } from "./platform/dashboard.mjs";
import { createInnovationRoutes, describeInnovationError } from "./platform/innovation/routes.mjs";
import { createTeamRoutes } from "./agent/team/routes.mjs";
import { createKnowledgeRoutes } from "./agent/knowledge-routes.mjs";
import { createPlatformApiRoutes } from "./platform/api-routes.mjs";
import { createRateLimiter, LIMITS } from "./rate-limit.mjs";

const MAX_BODY_BYTES = 64 * 1024;

export function createLocalControlServer({ store, token, runTask, model = "qwen2.5-coder:7b", discoverModels = discoverLocalModels, license = { mode: "community", valid: true }, runtime = null, missionService = null, transcriber = null, modelHealth = null, platformStore = null, platformServices = {}, innovation = null, platformStream = null, team = null, memory = null, connections = () => [], toolCatalog = null }) {
  if (!token || token.length < 32) throw new Error("ATLAS_LOCAL_TOKEN must contain at least 32 characters.");
  const expected = createHash("sha256").update(token).digest();
  const limiter = createRateLimiter();
  const agentRoutes = runtime ? createAgentRoutes({ runtime, transcriber, modelHealth }) : null;
  const missionRoutes = missionService ? createMissionRoutes({ missionService }) : null;
  const platformRoutes = platformStore ? createPlatformRoutes({ store: platformStore, stream: platformStream }) : null;
  const teamRoutes = team ? createTeamRoutes({ team, parseBody, send: (response, status, value) => { send(response, status, value); return true; } }) : null;
  const knowledgeRoutes = createKnowledgeRoutes({ memory, connections, send: (response, status, value) => { send(response, status, value); return true; } });
  const innovationRoutes = innovation ? createInnovationRoutes({ pipeline: innovation.pipeline, organization: innovation.organization, parseBody, send: (response, status, value) => { send(response, status, value); return true; } }) : null;
  const platformApi = platformStore ? createPlatformApiRoutes({ store: platformStore, ...platformServices, audit: (category, summary) => store.audit(category, summary) }) : null;

  async function startTask(taskId) {
    store.markRunning(taskId);
    try { const result = await runTask(store.get(taskId)); store.finish(taskId, result.ok ? "completed" : "failed", result.message); }
    catch (error) { store.finish(taskId, "failed", error instanceof Error ? error.message : "Unknown local runner failure."); }
  }

  return createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (request.method === "GET" && request.url === "/") return sendText(response, 200, "text/html; charset=utf-8", LOCAL_UI_HTML);
    if (request.method === "GET" && request.url === "/app.css") return sendText(response, 200, "text/css; charset=utf-8", LOCAL_UI_CSS);
    if (request.method === "GET" && (request.url === "/icon.svg" || request.url === "/favicon.ico")) return sendText(response, 200, "image/svg+xml", LOCAL_UI_ICON);
    if (request.method === "GET" && request.url === "/app.js") return sendText(response, 200, "text/javascript; charset=utf-8", LOCAL_UI_JS);
    if (platformRoutes?.handlePage(request, response)) return;
    if (innovationRoutes?.handlePage(request, response)) return;
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health") return send(response, 200, {
      status: "ok", mode: "sovereign", model, license,
      memory: process.memoryUsage(),
      runtime: runtime ? { running: true, executors: runtime.executorIds() } : { running: false, executors: [] },
      health: runtime ? runtime.healthSnapshot() : { activeAgents: 0, activeSessions: 0, queuedTurns: 0, sessions: 0 },
      batchQueueDepth: missionService?.list?.().filter((mission) => ["queued", "running", "paused"].includes(mission.status)).length ?? 0,
    });
    if (request.method === "POST" && request.url === "/v1/pair/claim") {
      const client = request.socket.remoteAddress ?? "unknown";
      const pairLimit = limiter.check({ bucket: "pairing", client, ...LIMITS.pairing });
      if (!pairLimit.allowed) { response.setHeader("retry-after", String(pairLimit.retryAfterSeconds)); return send(response, 429, { message: "Too many pairing attempts. Try again in one minute." }); }
      const body = await parseBody(request, response); if (!body) return;
      const codeHash = digest(String(body.code ?? "")); const now = new Date().toISOString();
      if (!store.consumePairingCode(codeHash, now)) return send(response, 401, { message: "Pairing code is invalid or expired." });
      const deviceToken = randomBytes(32).toString("base64url");
      // A correct code does not count against the limit.
      limiter.clear({ bucket: "pairing", client });
      const device = store.addDevice(String(body.name ?? "Phone").slice(0, 80), digest(deviceToken));
      return send(response, 201, { device, deviceToken });
    }
    const identity = authenticate(request.headers.authorization, expected, store);
    if (!identity) return send(response, 401, { message: "A valid local Atlas or paired-device token is required." });

    if (platformApi && await platformApi.handle(request, response, identity)) return;
    if (platformRoutes && platformRoutes.handle(request, response, identity)) return;
    if (!platformRoutes && (request.url ?? "").startsWith("/v1/platform/")) return send(response, 503, { message: "The Atlas platform task store is not running in this process." });
    if (teamRoutes && (request.url ?? "").startsWith("/v1/team/")) { if (await teamRoutes(request, response, identity)) return; }
    if (!teamRoutes && (request.url ?? "").startsWith("/v1/team/")) return send(response, 503, { message: "Agent missions are not running in this process." });
    // What agents can do on this machine, and what the owner's policy says about each capability.
    if (request.method === "GET" && request.url === "/v1/tools") return send(response, 200, { tools: (toolCatalog?.() ?? []).map((tool) => ({ ...tool, decision: store.policy(tool.capability).decision })) });
    if (/^\/v1\/(knowledge|connections)(\/|\?|$)/u.test(request.url ?? "")) { if (await knowledgeRoutes(request, response, identity)) return; }
    if (innovationRoutes && (request.url ?? "").startsWith("/v1/innovation/")) { if (await innovationRoutes.handle(request, response, identity)) return; }
    if (!innovationRoutes && (request.url ?? "").startsWith("/v1/innovation/")) return send(response, 503, { message: "The Atlas innovation pipeline is not running in this process." });
    if (missionRoutes && (request.url ?? "").startsWith("/v1/missions")) { if (await missionRoutes.handle(request, response, identity)) return; }
    if (!missionService && (request.url ?? "").startsWith("/v1/missions")) return send(response, 503, { message: "The Atlas mission service is not running in this process." });
    if (agentRoutes && (request.url ?? "").startsWith("/v1/sessions")) { if (await agentRoutes.handle(request, response, identity)) return; }
    if (agentRoutes && request.method === "GET" && request.url === "/v1/executors") { if (await agentRoutes.handle(request, response, identity)) return; }
    if (agentRoutes && request.method === "POST" && request.url === "/v1/transcribe") { if (await agentRoutes.handle(request, response, identity)) return; }
    if (agentRoutes && request.method === "GET" && request.url === "/v1/models/health") { if (await agentRoutes.handle(request, response, identity)) return; }
    if (!runtime && (request.url ?? "").startsWith("/v1/sessions")) return send(response, 503, { message: "The Atlas agent runtime is not running in this process." });
    if (request.method === "GET" && request.url === "/v1/tasks") return send(response, 200, { tasks: store.list() });
    if (request.method === "GET" && request.url === "/v1/models") { try { return send(response, 200, await discoverModels()); } catch (error) { return send(response, 503, { message: error instanceof Error ? error.message : "Model discovery failed.", models: [] }); } }
    if (request.method === "POST" && request.url === "/v1/tasks") {
      if (identity.role !== "admin") return send(response, 403, { message: "Only the local owner can create coding tasks." });
      const body = await parseBody(request, response); if (!body) return;
      const repository = typeof body.repository === "string" ? body.repository.trim() : "";
      const objective = typeof body.objective === "string" ? body.objective.trim() : "";
      if (!repository || repository.length > 4096 || !objective || objective.length > 10_000) {
        return send(response, 400, { message: "repository and objective are required and must be within bounds." });
      }
      const policy = store.policy("code.write");
      if (policy.decision === "deny") return send(response, 403, { message: "Local policy denies code.write." });
      const task = store.create({ repository, objective, model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : model, status: policy.decision === "ask" ? "awaiting_approval" : "queued" });
      if (policy.decision === "ask") return send(response, 202, { task, approval: store.createApproval({ taskId: task.id, capability: "code.write", summary: objective }) });
      queueMicrotask(() => startTask(task.id)); return send(response, 202, { task });
    }
    if (request.method === "GET" && request.url === "/v1/policies") return send(response, 200, { policies: store.policies() });
    if (request.method === "PUT" && request.url === "/v1/policies") { if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." }); const body = await parseBody(request,response); if (!body) return; try { return send(response,200,{ policy: store.setPolicy(body.capability,body.decision) }); } catch(error){ return send(response,400,{message:error.message}); } }
    if (request.method === "GET" && request.url === "/v1/approvals") return send(response, 200, { approvals: store.approvals() });
    const approvalMatch = request.method === "POST" ? /^\/v1\/approvals\/([0-9a-f-]+)\/decision$/u.exec(request.url ?? "") : null;
    if (approvalMatch) {
      // A stolen device token must not be able to sweep for pending approvals.
      const client = request.socket.remoteAddress ?? "unknown";
      const approvalLimit = limiter.check({ bucket: "approval", client, ...LIMITS.approval });
      if (!approvalLimit.allowed) {
        response.setHeader("retry-after", String(approvalLimit.retryAfterSeconds));
        return send(response, 429, { message: "Too many approval decisions in a short time. Try again shortly." });
      }
      const body = await parseBody(request, response); if (!body) return;
      try {
        // A build approval is bound to its Decision Packet: the pipeline checks the
        // digest and records who decided before the inbox entry is resolved.
        const pending = store.approval(approvalMatch[1]);
        if (pending?.capability === "innovation.build" && pending.status === "pending" && innovation) {
          if (!["approved", "denied"].includes(body.decision)) return send(response, 400, { message: "Invalid approval decision." });
          try {
            innovation.pipeline.decideFromApproval(LOCAL_TENANT_ID, pending.id, {
              approved: body.decision === "approved",
              actionDigest: pending.actionDigest,
              decidedBy: { kind: "human", id: identity.role === "admin" ? "local-owner" : `device:${identity.device?.id ?? "unknown"}` },
            });
          } catch (error) {
            const { status, body: detail } = describeInnovationError(error);
            return send(response, status, detail);
          }
          return send(response, 200, { approval: store.approval(pending.id) });
        }
        const approval = store.decideApproval(approvalMatch[1], body.decision);
        if (!approval) return send(response, 409, { message: "Approval is missing or already resolved." });
        if (approval.taskId) {
          if (body.decision === "approved") queueMicrotask(() => startTask(approval.taskId));
          else store.finish(approval.taskId, "failed", "Denied by local approval.");
        }
        // An agent session waiting on this approval carries on, or is told no.
        if (approval.sessionId && runtime) {
          queueMicrotask(() => {
            try {
              if (body.decision === "approved") runtime.resume(approval.sessionId);
              else runtime.denyApproval(approval.sessionId, approval.summary);
            } catch { /* The session may have been cancelled while waiting. */ }
          });
        }
        return send(response, 200, { approval });
      } catch (error) { return send(response, 400, { message: error.message }); }
    }
    if (request.method === "POST" && request.url === "/v1/pair") { if (identity.role !== "admin") return send(response,403,{message:"Owner access required."}); const code=String(randomInt(100000,1000000)); const expiresAt=new Date(Date.now()+5*60_000).toISOString(); store.addPairingCode(digest(code),expiresAt); return send(response,201,{code,expiresAt}); }
    if (request.method === "GET" && request.url === "/v1/devices") { if (identity.role !== "admin") return send(response,403,{message:"Owner access required."}); return send(response,200,{devices:store.devices()}); }
    const deviceMatch = request.method === "DELETE" ? /^\/v1\/devices\/([0-9a-f-]+)$/u.exec(request.url ?? "") : null;
    if (deviceMatch) { if (identity.role !== "admin") return send(response,403,{message:"Owner access required."}); const device=store.revokeDevice(deviceMatch[1]); return device?send(response,200,{device}):send(response,404,{message:"Active device not found."}); }
    if (request.method === "GET" && request.url === "/v1/audit") return send(response,200,{events:store.auditEvents()});
    if (request.method === "POST" && request.url === "/v1/export") { if(identity.role!=="admin") return send(response,403,{message:"Owner access required."}); const body=await parseBody(request,response); if(!body)return; try{return send(response,200,{backup:encryptBackup(store.snapshot(),body.passphrase)});}catch(error){return send(response,400,{message:error.message});} }
    if (request.method === "POST" && request.url === "/v1/import") { if(identity.role!=="admin") return send(response,403,{message:"Owner access required."}); const body=await parseBody(request,response); if(!body)return; try{store.importSnapshot(decryptBackup(body.backup,body.passphrase));return send(response,200,{imported:true});}catch(error){return send(response,400,{message:error.message});} }
    if (request.method === "POST" && request.url === "/v1/publish") { if(identity.role!=="admin") return send(response,403,{message:"Owner access required."}); if(store.policy("publish.remote").decision!=="allow") return send(response,409,{message:"Local policy must explicitly allow publish.remote for this session."}); const body=await parseBody(request,response); if(!body)return; try{const result=await publishChange(body);store.audit("publish.attempted",`${body.provider}: ${result.ok?result.url:result.message}`);return send(response,result.ok?201:502,result);}catch(error){return send(response,400,{message:error.message});} }
    const match = request.method === "GET" ? /^\/v1\/tasks\/([0-9a-f-]+)$/u.exec(request.url ?? "") : null;
    if (match) {
      const task = store.get(match[1]);
      return task ? send(response, 200, { task }) : send(response, 404, { message: "Task not found." });
    }
    return send(response, 404, { message: "Route not found." });
  });
}

function authenticate(header, expected, store) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7), actual = createHash("sha256").update(token).digest();
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) return { role: "admin" };
  const device = store.deviceByTokenHash(digest(token)); return device ? { role: "device", device } : null;
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
async function parseBody(request,response){try{return JSON.parse(await readBody(request));}catch(error){send(response,error?.code==="BODY_TOO_LARGE"?413:400,{message:error.message});return null;}}

async function readBody(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) { const error = new Error("Request body is too large."); error.code = "BODY_TOO_LARGE"; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response, status, value) { response.writeHead(status); response.end(JSON.stringify(value)); }
function sendText(response, status, contentType, value) { response.setHeader("content-type", contentType); response.writeHead(status); response.end(value); }
