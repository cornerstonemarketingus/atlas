import { getD1 } from "../../../../../../db";
import { hostedSiteStore } from "../../../../../../db/hosted-sites.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext, tenantScope } from "../../../../auth/tenant-context.mjs";
import { authenticatedAccount } from "../../../../tasks/operator-auth.mjs";
import { serveSiteExport } from "../../../site-export.mjs";

// A signed-in workspace member downloads their own hosted website as a ZIP.
// Scoped to tenant and principal like the hosted store: someone else's project is a 404.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401, headers: { "cache-control": "no-store" } });
  const { id } = await context.params;
  let tenant;
  try { tenant = await resolveTenantContext(request, account, getD1()); } catch { return Response.json({ message: "Exports are temporarily unavailable." }, { status: 503, headers: { "cache-control": "no-store" } }); }
  if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403, headers: { "cache-control": "no-store" } });
  return serveSiteExport({ id, store: hostedSiteStore(getD1()), scope: tenantScope(tenant) });
}
