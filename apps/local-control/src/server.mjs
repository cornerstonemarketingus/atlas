import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { LOCAL_UI_CSS, LOCAL_UI_HTML, LOCAL_UI_JS } from "./ui.mjs";
import { decryptBackup, encryptBackup } from "./encrypted-backup.mjs";
import { publishChange } from "./publish-adapters.mjs";
import { discoverLocalModels } from "./model-discovery.mjs";

const MAX_BODY_BYTES = 64 * 1024;

export function createLocalControlServer({ store, token, runTask, model = "qwen2.5-coder:7b", discoverModels = discoverLocalModels, license = { mode: "community", valid: true }, infrastructure = null }) {
  if (!token || token.length < 32) throw new Error("ATLAS_LOCAL_TOKEN must contain at least 32 characters.");
  const expected = createHash("sha256").update(token).digest();
  const pairAttempts = new Map();
  const activeRuns = new Map();
  const eventListeners = new Map();

  function emit(taskId, type, payload = {}) {
    const event = store.appendEvent(taskId, type, payload);
    for (const listener of eventListeners.get(taskId) ?? []) listener(event);
    return event;
  }

  async function startTask(taskId) {
    if (activeRuns.has(taskId)) return;
    const current = store.get(taskId);
    if (!current || !["queued", "awaiting_approval", "interrupted"].includes(current.status)) return;
    store.markRunning(taskId); emit(taskId, "task.started", { status: "running" });
    const controller = new AbortController(); activeRuns.set(taskId, controller);
    try {
      const result = await runTask(store.get(taskId), { signal: controller.signal, onEvent: ({ type, payload }) => emit(taskId, type, payload) });
      if (controller.signal.aborted || result.cancelled) { store.transition(taskId, "running", "cancelled", "Cancelled by the operator."); emit(taskId, "task.cancelled"); }
      else { store.finish(taskId, result.ok ? "completed" : "failed", result.message); emit(taskId, result.ok ? "task.completed" : "task.failed", { message: result.message }); }
    }
    catch (error) {
      const message = controller.signal.aborted ? "Cancelled by the operator." : error instanceof Error ? error.message : "Unknown local runner failure.";
      if (controller.signal.aborted) { store.transition(taskId, "running", "cancelled", message); emit(taskId, "task.cancelled"); }
      else { store.finish(taskId, "failed", message); emit(taskId, "task.failed", { message }); }
    }
    finally { activeRuns.delete(taskId); }
  }

  return createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (request.method === "GET" && request.url === "/") return sendText(response, 200, "text/html; charset=utf-8", LOCAL_UI_HTML);
    if (request.method === "GET" && request.url === "/app.css") return sendText(response, 200, "text/css; charset=utf-8", LOCAL_UI_CSS);
    if (request.method === "GET" && request.url === "/app.js") return sendText(response, 200, "text/javascript; charset=utf-8", LOCAL_UI_JS);
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { status: "ok", mode: "sovereign", model, license });
    if (request.method === "POST" && request.url === "/v1/pair/claim") {
      const client = request.socket.remoteAddress ?? "unknown", nowMs = Date.now();
      const attempts = (pairAttempts.get(client) ?? []).filter((time) => nowMs - time < 60_000);
      if (attempts.length >= 5) { response.setHeader("retry-after", "60"); return send(response, 429, { message: "Too many pairing attempts. Try again in one minute." }); }
      attempts.push(nowMs); pairAttempts.set(client, attempts);
      const body = await parseBody(request, response); if (!body) return;
      const codeHash = digest(String(body.code ?? "")); const now = new Date().toISOString();
      if (!store.consumePairingCode(codeHash, now)) return send(response, 401, { message: "Pairing code is invalid or expired." });
      const deviceToken = randomBytes(32).toString("base64url");
      const device = store.addDevice(String(body.name ?? "Phone").slice(0, 80), digest(deviceToken));
      return send(response, 201, { device, deviceToken });
    }
    const identity = authenticate(request.headers.authorization, expected, store);
    if (!identity) return send(response, 401, { message: "A valid local Atlas or paired-device token is required." });

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
      emit(task.id, "task.created", { status: task.status });
      if (policy.decision === "ask") return send(response, 202, { task, approval: store.createApproval({ taskId: task.id, capability: "code.write", summary: objective }) });
      queueMicrotask(() => startTask(task.id)); return send(response, 202, { task });
    }
    if (request.method === "GET" && request.url === "/v1/policies") return send(response, 200, { policies: store.policies() });
    if (request.method === "PUT" && request.url === "/v1/policies") { if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." }); const body = await parseBody(request,response); if (!body) return; try { return send(response,200,{ policy: store.setPolicy(body.capability,body.decision) }); } catch(error){ return send(response,400,{message:error.message}); } }
    if (request.method === "GET" && request.url === "/v1/approvals") return send(response, 200, { approvals: store.approvals() });
    const approvalMatch = request.method === "POST" ? /^\/v1\/approvals\/([0-9a-f-]+)\/decision$/u.exec(request.url ?? "") : null;
    if (approvalMatch) { const body = await parseBody(request,response); if (!body) return; try { const approval = store.decideApproval(approvalMatch[1], body.decision); if (!approval) return send(response,409,{message:"Approval is missing or already resolved."}); if (approval.taskId) { if (body.decision === "approved") queueMicrotask(()=>startTask(approval.taskId)); else store.finish(approval.taskId,"failed","Denied by local approval."); } return send(response,200,{approval}); } catch(error) { return send(response,400,{message:error.message}); } }
    if (request.method === "POST" && request.url === "/v1/pair") { if (identity.role !== "admin") return send(response,403,{message:"Owner access required."}); const code=String(randomInt(100000,1000000)); const expiresAt=new Date(Date.now()+5*60_000).toISOString(); store.addPairingCode(digest(code),expiresAt); return send(response,201,{code,expiresAt}); }
    if (request.method === "GET" && request.url === "/v1/devices") { if (identity.role !== "admin") return send(response,403,{message:"Owner access required."}); return send(response,200,{devices:store.devices()}); }
    const deviceMatch = request.method === "DELETE" ? /^\/v1\/devices\/([0-9a-f-]+)$/u.exec(request.url ?? "") : null;
    if (deviceMatch) { if (identity.role !== "admin") return send(response,403,{message:"Owner access required."}); const device=store.revokeDevice(deviceMatch[1]); return device?send(response,200,{device}):send(response,404,{message:"Active device not found."}); }
    if (request.method === "GET" && request.url === "/v1/audit") return send(response,200,{events:store.auditEvents()});
    if (request.method === "POST" && request.url === "/v1/export") { if(identity.role!=="admin") return send(response,403,{message:"Owner access required."}); const body=await parseBody(request,response); if(!body)return; try{return send(response,200,{backup:encryptBackup(store.snapshot(),body.passphrase)});}catch(error){return send(response,400,{message:error.message});} }
    if (request.method === "POST" && request.url === "/v1/import") { if(identity.role!=="admin") return send(response,403,{message:"Owner access required."}); const body=await parseBody(request,response); if(!body)return; try{store.importSnapshot(decryptBackup(body.backup,body.passphrase));return send(response,200,{imported:true});}catch(error){return send(response,400,{message:error.message});} }
    if (request.method === "POST" && request.url === "/v1/publish") { if(identity.role!=="admin") return send(response,403,{message:"Owner access required."}); if(store.policy("publish.remote").decision!=="allow") return send(response,409,{message:"Local policy must explicitly allow publish.remote for this session."}); const body=await parseBody(request,response); if(!body)return; try{const result=await publishChange(body);store.audit("publish.attempted",`${body.provider}: ${result.ok?result.url:result.message}`);return send(response,result.ok?201:502,result);}catch(error){return send(response,400,{message:error.message});} }
    if (request.method === "POST" && request.url === "/v1/infrastructure/preview") {
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
      if (!infrastructure) return send(response, 503, { message: "Infrastructure administration is not configured." });
      const body = await parseBody(request, response); if (!body) return;
      try { const plan = store.createInfrastructurePlan(infrastructure.preview(body.action, body.input)); return send(response, 201, { plan: publicPlan(plan) }); }
      catch (error) { return send(response, 400, { message: error.message }); }
    }
    const infrastructureMatch = request.method === "POST" ? /^\/v1\/infrastructure\/plans\/([0-9a-f-]+)\/execute$/u.exec(request.url ?? "") : null;
    if (infrastructureMatch) {
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
      if (!infrastructure) return send(response, 503, { message: "Infrastructure administration is not configured." });
      const plan = store.claimInfrastructurePlan(infrastructureMatch[1]);
      if (!plan) return send(response, 409, { message: "This exact action requires an unexpired, unused approval." });
      try { const receipt = await infrastructure.execute(plan); store.finishInfrastructurePlan(plan.id, "completed", receipt); return send(response, 200, { receipt }); }
      catch (error) { const receipt = { ok: false, message: error.message, action: plan.action, digest: plan.digest, preview: plan.preview }; store.finishInfrastructurePlan(plan.id, "failed", receipt); return send(response, 502, { receipt }); }
    }
    const match = request.method === "GET" ? /^\/v1\/tasks\/([0-9a-f-]+)$/u.exec(request.url ?? "") : null;
    if (match) {
      const task = store.get(match[1]);
      return task ? send(response, 200, { task }) : send(response, 404, { message: "Task not found." });
    }
    const eventsMatch = request.method === "GET" ? /^\/v1\/tasks\/([0-9a-f-]+)\/events(?:\?after=(\d+))?$/u.exec(request.url ?? "") : null;
    if (eventsMatch) {
      if (!store.get(eventsMatch[1])) return send(response, 404, { message: "Task not found." });
      return send(response, 200, { events: store.events(eventsMatch[1], Number(eventsMatch[2] ?? 0)) });
    }
    const streamMatch = request.method === "GET" ? /^\/v1\/tasks\/([0-9a-f-]+)\/stream(?:\?after=(\d+))?$/u.exec(request.url ?? "") : null;
    if (streamMatch) {
      const taskId = streamMatch[1]; if (!store.get(taskId)) return send(response, 404, { message: "Task not found." });
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" });
      const write = (event) => response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      for (const event of store.events(taskId, Number(streamMatch[2] ?? 0))) write(event);
      const listeners = eventListeners.get(taskId) ?? new Set(); listeners.add(write); eventListeners.set(taskId, listeners);
      const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000); keepAlive.unref();
      request.on("close", () => { clearInterval(keepAlive); listeners.delete(write); if (!listeners.size) eventListeners.delete(taskId); });
      return;
    }
    const cancelMatch = request.method === "POST" ? /^\/v1\/tasks\/([0-9a-f-]+)\/cancel$/u.exec(request.url ?? "") : null;
    if (cancelMatch) {
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
      const task = store.get(cancelMatch[1]); if (!task) return send(response, 404, { message: "Task not found." });
      if (!["queued", "awaiting_approval", "running", "interrupted"].includes(task.status)) return send(response, 409, { message: "Task is no longer cancellable." });
      activeRuns.get(task.id)?.abort();
      const cancelled = task.status === "running" ? store.get(task.id) : store.transition(task.id, task.status, "cancelled", "Cancelled by the operator.");
      if (task.status !== "running") emit(task.id, "task.cancelled");
      return send(response, 202, { task: cancelled });
    }
    const resumeMatch = request.method === "POST" ? /^\/v1\/tasks\/([0-9a-f-]+)\/resume$/u.exec(request.url ?? "") : null;
    if (resumeMatch) {
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
      const task = store.transition(resumeMatch[1], ["interrupted", "failed", "cancelled"], "queued", null);
      if (!task) return send(response, 409, { message: "Only interrupted, failed, or cancelled tasks can resume." });
      emit(task.id, "task.resumed", { status: "queued" }); queueMicrotask(() => startTask(task.id));
      return send(response, 202, { task });
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
function publicPlan(plan) { const { input: _input, ...safe } = plan; return safe; }
