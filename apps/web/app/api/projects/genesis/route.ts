import { getD1 } from "../../../../db";
import { canManageTenant } from "../../../../db/tenancy.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext } from "../../auth/tenant-context.mjs";
import { createInstallationToken, githubAppConfiguration } from "../../tasks/github-app.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { genesisProjectResponse } from "./service.mjs";

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required to create a project." }, { status: 401 });
  let tenant;
  try {
    tenant = await resolveTenantContext(request, account, getD1());
  } catch {
    return Response.json({ message: "Your workspace is unavailable. Apply D1 migration 0015_tenants." }, { status: 503 });
  }
  if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
  if (!canManageTenant(tenant.role)) return Response.json({ message: "Workspace owner or admin access is required to create a new repository." }, { status: 403 });
  try {
    const configuration = githubAppConfiguration();
    if (!configuration.configured) return Response.json({ message: "Project Genesis requires the GitHub App credentials to be configured." }, { status: 503 });
    const githubToken = await createInstallationToken(configuration, fetch, {
      repositories: [],
      permissions: { administration: "write", contents: "write", metadata: "read" },
    });
    return await genesisProjectResponse(request, { d1: getD1(), tenant, githubToken });
  } catch {
    return Response.json({ message: "GitHub App authentication failed, so no repository was created." }, { status: 502 });
  }
}
