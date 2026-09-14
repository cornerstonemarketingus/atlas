import { allowedRepositories } from "../../tasks/dispatch.mjs";
import { createInstallationToken, githubAppConfiguration } from "../../tasks/github-app.mjs";
import { authenticatedUserId } from "../../tasks/operator-auth.mjs";

const GITHUB_API = "https://api.github.com";

export async function GET(request: Request) {
  if (!(await authenticatedUserId(request))) return Response.json({ message: "Sign in is required." }, { status: 401 });

  const repositories = [...allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES)];
  const requestedRepository = new URL(request.url).searchParams.get("repository")?.toLowerCase() ?? repositories[0];
  if (!requestedRepository || !repositories.includes(requestedRepository)) {
    return Response.json({ message: "That repository is not on your Atlas allowlist." }, { status: 403 });
  }

  let token = process.env.ATLAS_GITHUB_TOKEN;
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
