const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_BASE = "https://api.github.com";
const STATE_COOKIE_NAME = "atlas_oauth_state";
const STATE_TTL_SECONDS = 600; // 10 minutes: only needs to outlive the round trip to GitHub and back

export function githubOAuthConfiguration(environment = process.env) {
  const clientId = environment.ATLAS_GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = environment.ATLAS_GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { configured: false };
  return { configured: true, clientId, clientSecret };
}

export function randomState() {
  return crypto.randomUUID().replace(/-/gu, "");
}

export function stateCookieHeader(state) {
  return `${STATE_COOKIE_NAME}=${state}; Max-Age=${STATE_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearStateCookieHeader() {
  return `${STATE_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readStateCookie(request) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() === STATE_COOKIE_NAME) return part.slice(separatorIndex + 1).trim();
  }
  return null;
}

export function authorizeUrl(configuration, { state, redirectUri }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", configuration.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(configuration, { code, redirectUri }, fetcher = fetch) {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: configuration.clientId, client_secret: configuration.clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!response.ok) throw new Error("GitHub OAuth token exchange failed.");
  const value = await response.json();
  if (!value || typeof value.access_token !== "string" || value.access_token.length === 0) {
    throw new Error(value && value.error_description ? `GitHub OAuth token exchange failed: ${value.error_description}` : "GitHub OAuth token exchange returned no access token.");
  }
  return value.access_token;
}

export async function fetchGitHubProfile(accessToken, fetcher = fetch) {
  const userResponse = await fetcher(`${API_BASE}/user`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "user-agent": "atlas-control-plane", "x-github-api-version": "2022-11-28" },
  });
  if (!userResponse.ok) throw new Error("Fetching the GitHub user profile failed.");
  const user = await userResponse.json();
  if (!user || typeof user.id !== "number" || typeof user.login !== "string") throw new Error("GitHub returned an unexpected user profile shape.");

  let email = typeof user.email === "string" ? user.email : null;
  if (!email) {
    const emailsResponse = await fetcher(`${API_BASE}/user/emails`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "user-agent": "atlas-control-plane", "x-github-api-version": "2022-11-28" },
    });
    if (emailsResponse.ok) {
      const emails = await emailsResponse.json();
      const primary = Array.isArray(emails) ? emails.find((candidate) => candidate.primary && candidate.verified) : null;
      email = primary ? primary.email : null;
    }
  }

  return { githubUserId: user.id, githubLogin: user.login, email, avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null };
}
