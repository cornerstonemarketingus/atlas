import { getD1 } from "../../../db";
import { NO_TENANT_MESSAGE, resolveTenantContext } from "../auth/tenant-context.mjs";

type Account = { userId: string; dbUserId: number | null };

/**
 * The caller's workspace for computer routes, or a 403 response. Devices and
 * approvals carry tenant_id (migration 0015); every read and write here is
 * scoped by it as well as by the requesting user, so a device or approval in
 * another workspace reads as unavailable.
 */
export async function computerTenant(request: Request, account: Account): Promise<{ tenantId: number } | Response> {
  const tenant = await resolveTenantContext(request, account, getD1());
  if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
  return { tenantId: tenant.tenantId };
}
