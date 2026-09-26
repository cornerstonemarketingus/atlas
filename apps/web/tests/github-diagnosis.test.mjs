import assert from "node:assert/strict";
import test from "node:test";

import { explainGitHubFailure, probeGitHubDispatch } from "../app/api/tasks/github-diagnosis.mjs";

test("each GitHub refusal names its cause and the fix", () => {
  assert.equal(explainGitHubFailure(401).blocked, "BLOCKED_BY_MISSING_CREDENTIAL");
  assert.match(explainGitHubFailure(401).unblock, /ATLAS_GITHUB_TOKEN/u);
  assert.match(explainGitHubFailure(403, { repository: "o/r" }).message, /o\/r/u);
  assert.equal(explainGitHubFailure(404).code, "GITHUB_NOT_FOUND");
  assert.equal(explainGitHubFailure(422).code, "GITHUB_DISPATCH_INVALID");
  assert.equal(explainGitHubFailure(502).blocked, "BLOCKED_BY_PROVIDER");
});

test("the setup probe checks the credential against the workflow, read-only", async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, method: init.method ?? "GET", auth: init.headers.authorization }); return new Response("{}", { status: url.includes("bad") ? 401 : 200 }); };
  assert.deepEqual(await probeGitHubDispatch({ token: "t", repository: "owner/repo", fetcher }), { ok: true });
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/repo/actions/workflows/atlas-runner.yml");
  assert.equal(calls[0].method, "GET", "the probe never dispatches anything");
  const expired = await probeGitHubDispatch({ token: "t", repository: "owner/bad", fetcher });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, "GITHUB_TOKEN_INVALID");
  assert.equal((await probeGitHubDispatch({ token: "", repository: "owner/repo", fetcher })).ok, false);
  assert.equal((await probeGitHubDispatch({ token: "t", repository: "owner/repo", fetcher: async () => { throw new Error("offline"); } })).code, "GITHUB_UNAVAILABLE");
});
