import { ControlError } from "../../../windows-companion/src/operator/control.mjs";

/**
 * /v1/operator: watch and control what Atlas is doing on this computer, from
 * the console or a paired phone.
 *
 * GET  /v1/operator                              state, site (host only), current action, elapsed time, approval state, recent milestones, uncertain actions
 * GET  /v1/operator/stream                       the same, live (server-sent events)
 * GET  /v1/operator/receipts?after=&limit=       the audit receipts of every control change and consequential action
 * POST /v1/operator/{pause|resume|takeover|handback|cancel|begin}   { reason? }
 * POST /v1/operator/intents/:id/acknowledge      { verdict: "happened" | "did_not_happen" }
 *
 * Any authenticated caller may use these, owner or paired device, and every
 * change is attributed to who made it. That is deliberate: the controls only
 * stop, hold or hand back what Atlas was already allowed to do, a paired phone
 * is the owner's own device, and consequential actions still need their own
 * exact approval. A request through a proxy still needs the paired device's
 * token (the owner token is refused remotely unless the owner allows it).
 * Nothing here returns a screenshot, a typed value, page text or a full URL.
 */
const ACTIONS = Object.freeze({ pause: "pause", resume: "resume", takeover: "takeover", handback: "handBack", cancel: "cancel", begin: "begin" });
const STATUS = Object.freeze({
  INVALID_TRANSITION: 409, NOT_UNCERTAIN: 409, ACTION_UNCERTAIN: 409, ACTION_ALREADY_DONE: 409,
  UNKNOWN_INTENT: 404, UNKNOWN_ACTION: 404, INVALID_VERDICT: 400, AUDIT_UNAVAILABLE: 503,
});
const INTENT_ID = "intent-[0-9]+-[0-9]+";
const HEARTBEAT_MS = 20_000;

export function actorOf(identity) {
  if (identity?.role === "admin") return "owner";
  const name = String(identity?.device?.name ?? identity?.device?.id ?? "device").replace(/[^A-Za-z0-9 ._-]/gu, "").slice(0, 40);
  return `device:${name || "unknown"}`;
}

export function createOperatorRoutes({ control, parseBody, send, heartbeatMs = HEARTBEAT_MS }) {
  const fail = (response, error) => (error instanceof ControlError
    ? send(response, STATUS[error.code] ?? 400, { code: error.code, message: error.message })
    : send(response, 500, { message: error instanceof Error ? error.message : "The request failed." }));

  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/operator")) return false;
    try {
      if (url.pathname === "/v1/operator") {
        if (request.method !== "GET") return send(response, 405, { message: "Method not allowed." });
        return send(response, 200, { status: control.status() });
      }
      if (url.pathname === "/v1/operator/receipts") {
        if (request.method !== "GET") return send(response, 405, { message: "Method not allowed." });
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) return send(response, 400, { message: "after and limit must be whole numbers (limit 1 to 500)." });
        return send(response, 200, { receipts: control.receipts({ after, limit }) });
      }
      if (url.pathname === "/v1/operator/stream") {
        if (request.method !== "GET") return send(response, 405, { message: "Method not allowed." });
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const push = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.status)}\n\n`);
        push({ type: "status", status: control.status() });
        const unsubscribe = control.subscribe(push);
        const beat = setInterval(() => response.write(": keep-alive\n\n"), heartbeatMs);
        beat.unref?.();
        const stop = () => { clearInterval(beat); unsubscribe(); };
        request.on?.("close", stop);
        response.on?.("close", stop);
        return true;
      }
      const action = /^\/v1\/operator\/(pause|resume|takeover|handback|cancel|begin)$/u.exec(url.pathname);
      if (action) {
        if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
        const body = await parseBody(request, response); if (!body) return true;
        const result = control[ACTIONS[action[1]]]({ actor: actorOf(identity), reason: typeof body.reason === "string" ? body.reason : null });
        return send(response, 200, result);
      }
      const acknowledge = new RegExp(`^/v1/operator/intents/(${INTENT_ID})/acknowledge$`, "u").exec(url.pathname);
      if (acknowledge) {
        if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
        const body = await parseBody(request, response); if (!body) return true;
        return send(response, 200, { status: control.acknowledge({ intentId: acknowledge[1], verdict: body.verdict, actor: actorOf(identity) }) });
      }
      return send(response, 404, { message: "Route not found." });
    } catch (error) {
      return fail(response, error);
    }
  };
}
