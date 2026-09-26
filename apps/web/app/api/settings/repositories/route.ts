import { getD1 } from "../../../../db";
import { canManageTenant, deleteTenantRepository, isDefaultTenant, listTenantRepositories, upsertTenantRepository } from "../../../../db/tenancy.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext } from "../../auth/tenant-context.mjs";
import { allowedRepositories } from "../../tasks/dispatch.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { tenantRepositoryDecision, validateRepositoryReference, validateRepositorySetting } from "./validation.mjs";

type Context = { tenantId: number; role: string; principal: string };

/**
 * The active tenant's repository allowlist + merge policy. Readable by every
 * member; editable by tenant owners and admins. ATLAS_ALLOWED_REPOSITORIES is
 * the deployment-wide upper bound on what any tenant can add.
 */
async function context(request: Request): Promise<Context | Response> {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  try {
    const resolved = await resolveTenantContext(request, account, getD1());
    if (!resolved) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    return resolved;
  } catch (error) {
    return Response.json({ message: toErrorMessage(error) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const resolved = await context(request);
  if (resolved instanceof Response) return resolved;
  try {
    const d1 = getD1();
    const rows = await listTenantRepositories(d1, resolved.tenantId);
    return Response.json({
      repositories: rows,
      deploymentAllowlist: [...allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES)],
      defaultTenant: await isDefaultTenant(d1, resolved.tenantId),
      canManage: canManageTenant(resolved.role),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ message: toErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const resolved = await context(request);
  if (resolved instanceof Response) return resolved;
  if (!canManageTenant(resolved.role)) return Response.json({ message: "Workspace owner or admin access is required to manage repositories." }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Request body must be valid JSON." }, { status: 400 });
  }
  const validated = validateRepositorySetting(body);
  if ("error" in validated) return Response.json({ message: validated.error }, { status: validated.status });

  try {
    const d1 = getD1();
    const decision = tenantRepositoryDecision(validated.setting, {
      deploymentAllowlist: allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES),
      defaultTenant: await isDefaultTenant(d1, resolved.tenantId),
    });
    if (!decision.allowed) return Response.json({ message: decision.error }, { status: decision.status });
    await upsertTenantRepository(d1, resolved.tenantId, validated.setting);
    return Response.json(validated.setting, { status: 200 });
  } catch (error) {
    return Response.json({ message: toErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const resolved = await context(request);
  if (resolved instanceof Response) return resolved;
  if (!canManageTenant(resolved.role)) return Response.json({ message: "Workspace owner or admin access is required to manage repositories." }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Request body must be valid JSON." }, { status: 400 });
  }
  const validated = validateRepositoryReference(body);
  if ("error" in validated) return Response.json({ message: validated.error }, { status: validated.status });
  try {
    const removed = await deleteTenantRepository(getD1(), resolved.tenantId, validated.reference);
    if (!removed) return Response.json({ message: "Repository not found." }, { status: 404 });
    return Response.json({ removed: true, ...validated.reference });
  } catch (error) {
    return Response.json({ message: toErrorMessage(error) }, { status: 500 });
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("no such")) {
    return "The tenancy tables are unavailable. Apply D1 migration 0015_tenants before using repository settings.";
  }
  return error instanceof Error ? error.message : "Unexpected error.";
}
