import assert from "node:assert/strict";
import test from "node:test";

import { credentialKind, explainDispatchFailure, explainGitHubFailure, probeGitHubDispatch } from "../app/api/tasks/github-diagnosis.mjs";

test("each GitHub refusal names its cause and the fix", () => {
  assert.equal(explainGitHubFailure(401).blocked, "BLOCKED_BY_MISSING_CREDENTIAL");
  assert.match(explainGitHubFailure(401).unblock, /ATLAS_GITHUB_TOKEN/u);
  assert.match(explainGitHubFailure(403, { repository: "o/r" }).message, /o\/r/u);
  assert.equal(explainGitHubFailure(404).code, "GITHUB_NOT_FOUND");
  assert.equal(explainGitHubFailure(422).code, "GITHUB_DISPATCH_INVALID");
  assert.equal(explainGitHubFailure(502).blocked, "BLOCKED_BY_PROVIDER");
});

/**
 * A fake GitHub: the workflow read answers `read`, the dispatch answers
 * `write`. Records every call so tests can see exactly what was sent.
 */
function github({ read = 200, write = 422, writeBody = '{"message":"No ref found for: atlas-permission-probe"}', readHeaders = {}, writeHeaders = {} } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    return url.endsWith("/dispatches")
      ? new Response(write === 204 ? null : writeBody, { status: write, headers: writeHeaders })
      : new Response("{}", { status: read, headers: readHeaders });
  };
  return { calls, fetcher };
}
const FINE = "github_pat_11AAAAexample";

test("credential kind comes from the prefix alone", () => {
  assert.equal(credentialKind(FINE), "fine-grained-pat");
  assert.equal(credentialKind("ghp_example"), "classic-pat");
  assert.equal(credentialKind("ghs_example"), "installation-token");
  assert.equal(credentialKind("ghs_example", { githubApp: true }), "github-app");
  assert.equal(credentialKind(undefined), "none");
  assert.equal(credentialKind("something-else"), "unknown");
});

test("a credential that can read but not dispatch is not reported ready (the production bug)", async () => {
  const { calls, fetcher } = github({ write: 403 });
  const result = await probeGitHubDispatch({ token: FINE, repository: "owner/repo", fetcher });
  assert.equal(result.ok, false);
  assert.equal(result.code, "GITHUB_PERMISSION_MISSING");
  assert.equal(result.missingPermission, "Actions");
  assert.equal(result.credential, "fine-grained-pat");
  assert.match(result.unblock, /Repository permissions → Actions: Read and write/u);
  assert.match(result.unblock, /Deploy Atlas web/u);
  assert.equal(calls.length, 2);
});

test("the write probe targets a branch that cannot exist, so nothing ever runs", async () => {
  const { calls, fetcher } = github();
  assert.deepEqual(await probeGitHubDispatch({ token: FINE, repository: "owner/repo", fetcher }), { ok: true, credential: "fine-grained-pat" });
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/repo/actions/workflows/atlas-runner.yml");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].url, "https://api.github.com/repos/owner/repo/actions/workflows/atlas-runner.yml/dispatches");
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].body.ref, /^atlas-permission-probe-[0-9a-f-]{36}$/u);
  assert.deepEqual(Object.keys(calls[1].body), ["ref"], "no inputs, so no objective, repository or task is ever sent");
});

test("only a 'no such ref' 422 proves permission; any other 422 is reported as unverified", async () => {
  const { fetcher } = github({ writeBody: '{"message":"Unexpected inputs provided"}' });
  const result = await probeGitHubDispatch({ token: FINE, repository: "owner/repo", fetcher });
  assert.equal(result.ok, false);
  assert.equal(result.code, "GITHUB_PERMISSION_UNVERIFIED");
});

test("a classic token is judged by its scopes, with no write probe", async () => {
  const withRepo = github({ readHeaders: { "x-oauth-scopes": "repo, workflow" } });
  assert.deepEqual(await probeGitHubDispatch({ token: "ghp_x", repository: "owner/repo", fetcher: withRepo.fetcher }), { ok: true, credential: "classic-pat" });
  assert.equal(withRepo.calls.length, 1);
  const withoutRepo = github({ readHeaders: { "x-oauth-scopes": "read:org" } });
  const result = await probeGitHubDispatch({ token: "ghp_x", repository: "owner/repo", fetcher: withoutRepo.fetcher });
  assert.equal(result.missingPermission, "repo scope");
  assert.match(result.unblock, /"repo" scope/u);
});

test("a GitHub App gets App-specific instructions", async () => {
  const { fetcher } = github({ write: 403 });
  const result = await probeGitHubDispatch({ token: "ghs_x", repository: "owner/repo", fetcher, githubApp: true });
  assert.equal(result.credential, "github-app");
  assert.match(result.unblock, /GitHub App's settings → Permissions/u);
});

test("a 403 from an exhausted rate limit is not reported as a missing permission", async () => {
  const { fetcher } = github({ write: 403, writeHeaders: { "x-ratelimit-remaining": "0" } });
  const result = await probeGitHubDispatch({ token: FINE, repository: "owner/repo", fetcher });
  assert.equal(result.code, "GITHUB_RATE_LIMITED");
  const refused = explainDispatchFailure(new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), { workflow: "w", repository: "o/r", credential: "fine-grained-pat" });
  assert.equal(refused.code, "GITHUB_RATE_LIMITED");
});

test("a refused dispatch names the credential kind and its fix, never the body", async () => {
  const failure = explainDispatchFailure(new Response("SECRET echoed body", { status: 403 }), { workflow: "atlas-runner.yml", repository: "o/r", credential: "fine-grained-pat" });
  assert.equal(failure.code, "GITHUB_PERMISSION_MISSING");
  assert.match(failure.message, /\(fine-grained-pat\) cannot run workflows on o\/r/u);
  assert.doesNotMatch(JSON.stringify(failure), /SECRET/u);
  assert.equal(explainDispatchFailure(new Response("", { status: 401 }), { workflow: "w", repository: "o/r" }).code, "GITHUB_TOKEN_INVALID");
});

test("the probe never reports any part of the token", async () => {
  const { fetcher } = github({ write: 403 });
  const result = await probeGitHubDispatch({ token: "github_pat_SECRETVALUE123", repository: "owner/repo", fetcher });
  assert.doesNotMatch(JSON.stringify(result), /SECRETVALUE/u);
});

test("read failures and outages keep their existing explanations", async () => {
  const expired = await probeGitHubDispatch({ token: FINE, repository: "owner/repo", fetcher: github({ read: 401 }).fetcher });
  assert.equal(expired.code, "GITHUB_TOKEN_INVALID");
  assert.equal((await probeGitHubDispatch({ token: "", repository: "owner/repo", fetcher: github().fetcher })).ok, false);
  assert.equal((await probeGitHubDispatch({ token: FINE, repository: "owner/repo", fetcher: async () => { throw new Error("offline"); } })).code, "GITHUB_UNAVAILABLE");
});

test("a GitHub App without Actions: write is told exactly that, with the App's grant steps", async () => {
  const { explainGitHubAppFailure } = await import("../app/api/tasks/github-diagnosis.mjs");
  const missing = explainGitHubAppFailure({ code: "GITHUB_APP_PERMISSION_MISSING" }, { repository: "o/r" });
  assert.equal(missing.code, "GITHUB_PERMISSION_MISSING");
  assert.equal(missing.missingPermission, "Actions");
  assert.equal(missing.credential, "github-app");
  assert.match(missing.unblock, /GitHub App's settings → Permissions/u);
  assert.equal(explainGitHubAppFailure({ code: "GITHUB_APP_INSTALLATION_NOT_FOUND" }).code, "GITHUB_APP_INSTALLATION_NOT_FOUND");
  assert.equal(explainGitHubAppFailure({ code: "GITHUB_APP_KEY_REJECTED" }).code, "GITHUB_APP_KEY_REJECTED");
  assert.equal(explainGitHubAppFailure(new Error("anything")).code, "GITHUB_APP_AUTH_FAILED");
});
