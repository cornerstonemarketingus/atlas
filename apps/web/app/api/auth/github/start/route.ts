import { githubOAuthConfiguration, randomState, stateCookieHeader, authorizeUrl, publicOrigin } from "../../github-oauth.mjs";
import { getDb } from "../../../../../db";
import { requestRateLimits } from "../../../../../db/schema";
import { enforceRateLimit, rateLimitSubjectForIp } from "../../../rate-limit.mjs";

export async function GET(request: Request) {
  const limited = await enforceRateLimit({
    db: getDb,
    table: requestRateLimits,
    request,
    subject: rateLimitSubjectForIp(request),
    route: "auth_github_start",
    limit: 20,
    windowSeconds: 15 * 60,
  });
  if (limited) return limited;
  const configuration = githubOAuthConfiguration();
  if (!configuration.configured) {
    return Response.json({ message: "GitHub sign-in is not configured yet." }, { status: 503 });
  }
  const origin = publicOrigin(request);
  const state = randomState();
  const url = authorizeUrl(configuration, { state, redirectUri: `${origin}/api/auth/github/callback` });
  return new Response(null, { status: 302, headers: { location: url, "set-cookie": stateCookieHeader(state) } });
}
