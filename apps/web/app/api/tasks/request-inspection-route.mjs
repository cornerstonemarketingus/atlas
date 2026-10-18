import { getD1 } from "../../../db";
import { authenticatedAccount } from "./operator-auth.mjs";
import { resolveTenantContext, tenantScope, NO_TENANT_MESSAGE } from "../auth/tenant-context.mjs";
import { TASK_REQUEST_KEY } from "./task-request-contract.mjs";
import { decodeRequestCursor, inspectTaskRequest, listTaskRequests } from "./request-inspection.mjs";

const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Read-only request inspection; no dispatch, model, provider or billing calls. */
export async function requestInspectionResponse(request, requestKey) {
  try {
    const account = await authenticatedAccount(request);
    if (!account) return reply({ message: "Sign in is required." }, 401);
    if (requestKey !== undefined && !TASK_REQUEST_KEY.test(requestKey)) return reply({ message: "Request not found." }, 404);
    let cursor;
    try { cursor = requestKey === undefined ? decodeRequestCursor(new URL(request.url).searchParams.get("cursor")) : null; }
    catch { return reply({ message: "The request history page is invalid." }, 400); }
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return reply({ message: NO_TENANT_MESSAGE }, 403);
    const scope = tenantScope(tenant);
    if (requestKey === undefined) return reply(await listTaskRequests(d1, scope, cursor));
    const result = await inspectTaskRequest(d1, scope, requestKey.toLowerCase());
    return result ? reply({ request: result }) : reply({ message: "Request not found." }, 404);
  } catch { return reply({ message: "Saved request history is unavailable. Try again later." }, 503); }
}
