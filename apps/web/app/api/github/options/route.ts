import { getD1 } from "../../../../db";
import { tenantAllowlist } from "../../../../db/tenancy.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext } from "../../auth/tenant-context.mjs";
import { allowedRepositories } from "../../tasks/dispatch.mjs";
import { createInstallationToken, githubAppConfiguration } from "../../tasks/github-app.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { platformGitHubToken } from "../../tasks/github-token.mjs";

const GITHUB_API = "https://api.github.com";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });

  // The active tenant's allowlist, bounded by ATLAS_ALLOWED_REPOSITORIES.
  let repositories: string[];
  try {
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    repositories = [...await tenantAllowlist(d1, tenant.tenantId, allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES))];
  } catch {
    return Response.json({ message: "Your workspace's repositories are unavailable." }, { status: 503 });
  }
  const requested = new URL(request.url).searchParams.get("repository")?.toLowerCase();
  if (!requested && repositories.length === 0) return Response.json({ repositories, defaultBranch: "main", branches: ["main"] });
  const requestedRepository = requested ?? repositories[0];
  if (!requestedRepository || !repositories.includes(requestedRepository)) {
    return Response.json({ message: "That repository is not on your Atlas allowlist." }, { status: 403 });
  }

  let token = platformGitHubToken();
  try {
    const configuration = githubAppConfiguration();
    if (configuration.configured) token = await createInstallationToken(configuration);
  } catch {
    // The dropdown still remains useful with its safe default below.
  }

  let defaultBranch = "main";
  let branches = [defaultBranch];
  if (token) {
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "atlas-control-plane",
      "x-github-api-version": "2022-11-28",
    };
    try {
      const [repositoryResponse, branchesResponse] = await Promise.all([
        fetch(`${GITHUB_API}/repos/${requestedRepository}`, { headers }),
        fetch(`${GITHUB_API}/repos/${requestedRepository}/branches?per_page=100`, { headers }),
      ]);
      if (repositoryResponse.ok) {
        const metadata = await repositoryResponse.json() as { default_branch?: unknown };
        if (typeof metadata.default_branch === "string" && metadata.default_branch) defaultBranch = metadata.default_branch;
      }
      if (branchesResponse.ok) {
        const rows = await branchesResponse.json() as { name?: unknown }[];
        branches = rows.flatMap((row) => typeof row.name === "string" && row.name ? [row.name] : []);
      }
    } catch {
      // A temporary GitHub failure should not remove the default selection.
    }
  }

  return Response.json({
    repositories,
    defaultBranch,
    branches: [defaultBranch, ...branches.filter((name) => name !== defaultBranch)],
  });
}
