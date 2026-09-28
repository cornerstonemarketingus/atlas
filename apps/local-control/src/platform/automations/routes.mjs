import { AutomationError } from "./service.mjs";

/**
 * /v1/automations — authenticated; reading is open to any caller, changing
 * and running automations needs the owner.
 *
 * GET    /v1/automations                    list (with each one's last run)
 * POST   /v1/automations                    { name, trigger, action, maxRunsPerDay? }
 * GET    /v1/automations/:id                one automation and its run history
 * DELETE /v1/automations/:id
 * POST   /v1/automations/:id/(run|pause|resume)
 *
 * /v1/hooks/:id/:secret — the webhook trigger, handled before bearer
 * authentication (the secret in the path is the credential; rate limited).
 */
const ID = "auto-[0-9a-f-]{36}";
const STATUS = { INVALID_AUTOMATION: 400, INVALID_SCHEDULE: 400, UNKNOWN_AUTOMATION: 404, UNAUTHORIZED: 404, UNAVAILABLE: 503 };

export function createAutomationRoutes({ automations, parseBody, send }) {
  const fail = (response, error) => (error instanceof AutomationError
    ? send(response, STATUS[error.code] ?? 400, { code: error.code, message: error.message })
    : send(response, 500, { message: error instanceof Error ? error.message : "The request failed." }));

  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/automations")) return false;
    try {
      if (url.pathname === "/v1/automations") {
        if (request.method === "GET") return send(response, 200, { automations: automations.list() });
        if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
        if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
        const body = await parseBody(request, response); if (!body) return true;
        const created = automations.create(body);
        return send(response, 201, {
          ...created,
          ...(created.webhookSecret ? { webhookPath: `/v1/hooks/${created.automation.id}/${created.webhookSecret}`, note: "Copy the webhook address now; Atlas stores only a hash of its secret." } : {}),
        });
      }
      const match = new RegExp(`^/v1/automations/(${ID})(?:/(run|pause|resume))?$`, "u").exec(url.pathname);
      if (!match) return send(response, 404, { message: "Route not found." });
      const [, id, action] = match;
      if (request.method === "GET" && !action) {
        const automation = automations.get(id);
        return automation ? send(response, 200, { automation }) : send(response, 404, { message: "Automation not found." });
      }
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
      if (request.method === "DELETE" && !action) return send(response, 200, { deleted: automations.remove(id) });
      if (request.method !== "POST" || !action) return send(response, 405, { message: "Method not allowed." });
      if (action === "run") return send(response, 202, { run: await automations.runNow(id) });
      return send(response, 200, { automation: action === "pause" ? automations.pause(id) : automations.resume(id) });
    } catch (error) {
      return fail(response, error);
    }
  };
}

/** The webhook trigger. Returns false for paths it does not own. */
export function createWebhookRoute({ automations, readRaw, send, limiter = null }) {
  return async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    const match = new RegExp(`^/v1/hooks/(${ID})/([A-Za-z0-9_-]{20,100})$`, "u").exec(url.pathname);
    if (!match) return false;
    if (request.method !== "POST") return send(response, 405, { message: "Webhooks accept POST only." });
    if (limiter) {
      const allowed = limiter.check({ bucket: "webhook", client: `${request.socket.remoteAddress ?? "unknown"}:${match[1]}`, limit: 60, windowMs: 60_000 });
      if (!allowed.allowed) {
        response.setHeader("retry-after", String(allowed.retryAfterSeconds));
        return send(response, 429, { message: "Too many deliveries; slow down." });
      }
    }
    const body = await readRaw(request, response);
    if (body === null) return true;
    const key = request.headers["idempotency-key"] ?? request.headers["x-github-delivery"] ?? request.headers["x-request-id"] ?? null;
    try {
      const run = await automations.deliver(match[1], match[2], { idempotencyKey: typeof key === "string" ? key : null, body });
      // Accepted whether it ran, was skipped or was a duplicate: the sender did nothing wrong.
      return send(response, 202, { status: run.status, runId: run.id ?? null, message: run.message ?? null });
    } catch (error) {
      if (error instanceof AutomationError && error.code === "UNAUTHORIZED") return send(response, 404, { message: "Unknown webhook." });
      return send(response, 500, { message: "The delivery could not be recorded." });
    }
  };
}
