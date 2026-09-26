import { getD1 } from "../../../../db";
import { setAutomationPaused } from "../../../../db/tenancy.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext, tenantScope } from "../../auth/tenant-context.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { paused?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (typeof body.paused !== "boolean") return Response.json({ message: "Paused flag is required." }, { status: 400 });
  const { id } = await context.params;
  let tenant: { tenantId: number; role: string; principal: string } | null;
  try {
    tenant = await resolveTenantContext(request, account, getD1());
  } catch {
    return Response.json({ message: "Automations are temporarily unavailable. Apply D1 tenancy migrations." }, { status: 503 });
  }
  if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
  const updated = await setAutomationPaused(getD1(), tenantScope(tenant), { id, paused: body.paused });
  if (!updated) return Response.json({ message: "Automation not found." }, { status: 404 });
  return Response.json({ automation: { id: updated.id, paused: updated.pausedAt !== null, pausedAt: updated.pausedAt } });
}
