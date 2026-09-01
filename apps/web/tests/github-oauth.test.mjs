import assert from "node:assert/strict";
import test from "node:test";
import {
  githubOAuthConfiguration,
  authorizeUrl,
  exchangeCodeForToken,
  fetchGitHubProfile,
  randomState,
  stateCookieHeader,
  clearStateCookieHeader,
  readStateCookie,
} from "../app/api/auth/github-oauth.mjs";

test("reports unconfigured when either client credential is missing", () => {
  assert.equal(githubOAuthConfiguration({}).configured, false);
  assert.equal(githubOAuthConfiguration({ ATLAS_GITHUB_OAUTH_CLIENT_ID: "id" }).configured, false);
  assert.equal(githubOAuthConfiguration({ ATLAS_GITHUB_OAUTH_CLIENT_ID: "id", ATLAS_GITHUB_OAUTH_CLIENT_SECRET: "secret" }).configured, true);
});

test("builds an authorize URL carrying state and redirect_uri", () => {
  const configuration = { clientId: "client-id", clientSecret: "client-secret" };
  const url = new URL(authorizeUrl(configuration, { state: "xyz", redirectUri: "https://example.com/api/auth/github/callback" }));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("state"), "xyz");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/api/auth/github/callback");
});

test("exchanges a code for an access token", async () => {
  let observedBody;
  const fetcher = async (_url, init) => {
    observedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ access_token: "gho_token", token_type: "bearer" }), { status: 200 });
  };
  const token = await exchangeCodeForToken({ clientId: "id", clientSecret: "secret" }, { code: "abc", redirectUri: "https://example.com/cb" }, fetcher);
  assert.equal(token, "gho_token");
  assert.equal(observedBody.code, "abc");
  assert.equal(observedBody.redirect_uri, "https://example.com/cb");
});

test("rejects a token exchange that returns no access token", async () => {
  const fetcher = async () => new Response(JSON.stringify({ error: "bad_verification_code", error_description: "expired" }), { status: 200 });
  await assert.rejects(exchangeCodeForToken({ clientId: "id", clientSecret: "secret" }, { code: "abc", redirectUri: "https://example.com/cb" }, fetcher), /expired/u);
});

test("fetches a profile and falls back to the primary verified email", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/user")) return new Response(JSON.stringify({ id: 99, login: "octocat", email: null, avatar_url: "https://example.com/a.png" }), { status: 200 });
    return new Response(JSON.stringify([{ email: "unverified@example.com", primary: true, verified: false }, { email: "primary@example.com", primary: true, verified: true }]), { status: 200 });
  };
  const profile = await fetchGitHubProfile("token", fetcher);
  assert.deepEqual(profile, { githubUserId: 99, githubLogin: "octocat", email: "primary@example.com", avatarUrl: "https://example.com/a.png" });
});

test("state and cookie helpers round-trip", () => {
  const state = randomState();
  assert.match(state, /^[0-9a-f]{32}$/u);
  const header = stateCookieHeader(state);
  assert.match(header, new RegExp(`^atlas_oauth_state=${state};`, "u"));
  assert.match(clearStateCookieHeader(), /^atlas_oauth_state=; Max-Age=0/u);
  const request = new Request("http://localhost/", { headers: { cookie: `atlas_oauth_state=${state}` } });
  assert.equal(readStateCookie(request), state);
});
