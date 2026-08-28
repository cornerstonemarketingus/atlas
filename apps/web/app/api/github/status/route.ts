import { githubAppConfiguration, githubAppInstallUrl } from "../../tasks/github-app.mjs";
import { authenticatedUserId } from "../../tasks/operator-auth.mjs";

export async function GET(request: Request) {
  if (!authenticatedUserId(request)) return Response.json({ message: "Sign in is required." }, { status: 401 });
  try {
    const configuration = githubAppConfiguration();
    return Response.json({ connected: configuration.configured, method: configuration.configured ? "github-app" : process.env.ATLAS_GITHUB_TOKEN ? "operator-token" : "none", installUrl: githubAppInstallUrl(configuration.slug) });
  } catch {
    return Response.json({ connected: false, method: "invalid-configuration", installUrl: null }, { status: 503 });
  }
}
