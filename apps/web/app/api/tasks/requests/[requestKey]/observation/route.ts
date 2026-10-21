import { getD1 } from "../../../../../../db";
import { authenticatedAccount } from "../../../operator-auth.mjs";
import { resolveTenantContext, tenantScope, NO_TENANT_MESSAGE } from "../../../../auth/tenant-context.mjs";
import { TASK_REQUEST_KEY } from "../../../task-request-contract.mjs";
import { configureObservation } from "../../../outcome-observer.mjs";
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, context: { params: Promise<{ requestKey: string }> }) {
  try {
    const account = await authenticatedAccount(request); if (!account) return reply({ message: "Sign in is required." }, 401);
    const origin = request.headers.get("origin");
    if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return reply({ message: "Same-origin request required." }, 403);
    const { requestKey } = await context.params; if (!TASK_REQUEST_KEY.test(requestKey)) return reply({ message: "Request not found." }, 404);
    let enabled: boolean;
    try {
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
      const reader = request.body?.getReader(); if (!reader) throw new Error();
      let text = ""; let size = 0; const decoder = new TextDecoder();
      try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 256) throw new Error(); text += decoder.decode(value, { stream: true }); } text += decoder.decode(); }
      finally { await reader.cancel(); }
      const body = JSON.parse(text);
      if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") throw new Error();
      enabled = body.enabled;
    } catch { return reply({ message: "Provide only an enabled boolean." }, 400); }
    const d1 = getD1(); const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return reply({ message: NO_TENANT_MESSAGE }, 403);
    const result = await configureObservation(d1, tenantScope(tenant), requestKey.toLowerCase(), account.dbUserId, enabled);
    if (result.status === "not-found") return reply({ message: "Request not found." }, 404);
    if (result.status !== "configured") return reply({ message: "This saved claim cannot enable automatic observation. Manual reconciliation remains available." }, 409);
    return reply({ request: result.request });
  } catch { return reply({ message: "Observation settings are unavailable. No execution was started." }, 503); }
}
