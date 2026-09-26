import { getD1 } from "../../../../db";
import { archiveConversation, getConversation } from "../../../../db/tenancy.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext, tenantScope } from "../../auth/tenant-context.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const { id } = await context.params;
  try {
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    // Another tenant's (or member's) conversation is indistinguishable from a missing one.
    const found = await getConversation(d1, tenantScope(tenant), id);
    if (!found) return Response.json({ message: "Conversation not found." }, { status: 404 });
    return Response.json(found, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ message: "Conversation history is unavailable." }, { status: 503 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const { id } = await context.params;
  try {
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    if (!(await archiveConversation(d1, tenantScope(tenant), id))) return Response.json({ message: "Conversation not found." }, { status: 404 });
    return Response.json({ closed: true, id });
  } catch {
    return Response.json({ message: "The conversation could not be closed." }, { status: 503 });
  }
}
