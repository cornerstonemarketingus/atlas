import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { requestRateLimits, subscriptions, users } from "../../../../../db/schema";
import { exchangeCodeForToken, fetchGitHubProfile, githubOAuthConfiguration, clearStateCookieHeader, isOwnerGitHubLogin, readStateCookie, publicOrigin } from "../../github-oauth.mjs";
import { enforceRateLimit, rateLimitSubjectForIp } from "../../../rate-limit.mjs";
import { OWNER_SESSION_TTL_SECONDS, signSession, sessionCookieHeader } from "../../session.mjs";

export async function GET(request: Request) {
  const limited = await enforceRateLimit({
    db: getDb,
    table: requestRateLimits,
    request,
    subject: rateLimitSubjectForIp(request),
    route: "auth_github_callback",
    limit: 20,
    windowSeconds: 15 * 60,
  });
  if (limited) return limited;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = readStateCookie(request);
  const clearState = clearStateCookieHeader();

  if (!code || !state || !cookieState || state !== cookieState) {
    return new Response("GitHub sign-in failed: the request could not be verified. Please try again.", {
      status: 400,
      headers: { "content-type": "text/plain", "set-cookie": clearState },
    });
  }

  const configuration = githubOAuthConfiguration();
  if (!configuration.configured) {
    return new Response("GitHub sign-in is not configured.", { status: 503, headers: { "set-cookie": clearState } });
  }

  try {
    const accessToken = await exchangeCodeForToken(configuration, { code, redirectUri: `${publicOrigin(request)}/api/auth/github/callback` });
    const profile = await fetchGitHubProfile(accessToken);

    const db = getDb();
    await db
      .insert(users)
      .values({ githubUserId: profile.githubUserId, githubLogin: profile.githubLogin, email: profile.email, avatarUrl: profile.avatarUrl })
      .onConflictDoUpdate({
        target: users.githubUserId,
        set: { githubLogin: profile.githubLogin, email: profile.email, avatarUrl: profile.avatarUrl },
      });
    const [user] = await db.select().from(users).where(eq(users.githubUserId, profile.githubUserId));
    if (!user) throw new Error("User record was not persisted.");

    await db.insert(subscriptions).values({ userId: user.id, tier: "free", status: "active" }).onConflictDoNothing({ target: subscriptions.userId });

    const sessionSecret = process.env.ATLAS_SESSION_SECRET;
    if (!sessionSecret) throw new Error("ATLAS_SESSION_SECRET is not configured.");
    // Owner sessions carry deployment authority: 12 hours, not 30 days (SEC-2).
    const owner = isOwnerGitHubLogin(user.githubLogin);
    const ttlSeconds = owner ? OWNER_SESSION_TTL_SECONDS : undefined;
    const token = await signSession(
      owner ? { role: "operator", gh: user.githubLogin } : { uid: user.id, gh: user.githubLogin },
      sessionSecret,
      Date.now(),
      ttlSeconds,
    );

    const headers = new Headers({ location: `${publicOrigin(request)}/` });
    headers.append("set-cookie", clearState);
    headers.append("set-cookie", sessionCookieHeader(token, ttlSeconds));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return new Response(`GitHub sign-in failed: ${error instanceof Error ? error.message : "unexpected error"}.`, {
      status: 502,
      headers: { "content-type": "text/plain", "set-cookie": clearState },
    });
  }
}
