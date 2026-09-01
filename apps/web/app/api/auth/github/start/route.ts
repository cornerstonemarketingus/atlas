import { githubOAuthConfiguration, randomState, stateCookieHeader, authorizeUrl } from "../../github-oauth.mjs";

export async function GET(request: Request) {
  const configuration = githubOAuthConfiguration();
  if (!configuration.configured) {
    return Response.json({ message: "GitHub sign-in is not configured yet." }, { status: 503 });
  }
  const origin = new URL(request.url).origin;
  const state = randomState();
  const url = authorizeUrl(configuration, { state, redirectUri: `${origin}/api/auth/github/callback` });
  return new Response(null, { status: 302, headers: { location: url, "set-cookie": stateCookieHeader(state) } });
}
