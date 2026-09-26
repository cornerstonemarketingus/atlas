import { getD1 } from "../../../db";
import { listConversations } from "../../../db/tenancy.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext, tenantScope } from "../auth/tenant-context.mjs";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  try {
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    const rows = await listConversations(d1, tenantScope(tenant), 50);
    return Response.json({ conversations: rows }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ conversations: [], historyAvailable: false });
  }
}
