// Resolves the caller's tenant for a request whose identity
// authenticatedAccount() already established (including main's session
// revocation check). See db/tenancy.mjs `resolveTenant` for the rules.
import { requestedTenantFromHeader, resolveTenant } from "../../../db/tenancy.mjs";

export const TENANT_HEADER = "x-atlas-tenant";
export const NO_TENANT_MESSAGE = "You are not a member of that workspace.";

/** { tenantId, role, principal } or null (→ 403; the caller named a workspace they are not in). */
export async function resolveTenantContext(request, account, d1) {
  const requestedTenantId = requestedTenantFromHeader(request.headers.get(TENANT_HEADER));
  if (Number.isNaN(requestedTenantId)) return null;
  return resolveTenant(d1, account, { requestedTenantId });
}

export function tenantScope(context) {
  return { tenantId: context.tenantId, principal: context.principal };
}
