import { githubAppConfiguration, githubAppInstallUrl } from "../../tasks/github-app.mjs";
import { authenticatedUserId } from "../../tasks/operator-auth.mjs";
import { platformGitHubToken } from "../../tasks/github-token.mjs";

export async function GET(request: Request) {
  if (!(await authenticatedUserId(request))) return Response.json({ message: "Sign in is required." }, { status: 401 });
  try {
    const configuration = githubAppConfiguration();
    const operatorTokenConfigured = Boolean(platformGitHubToken());
    return Response.json({
      connected: configuration.configured || operatorTokenConfigured,
      method: configuration.configured ? "github-app" : operatorTokenConfigured ? "operator-token" : "none",
      installUrl: githubAppInstallUrl(configuration.slug),
    });
  } catch {
    return Response.json({ connected: false, method: "invalid-configuration", installUrl: null }, { status: 503 });
  }
}
