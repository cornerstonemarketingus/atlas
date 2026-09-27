import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createGitHubAppJwt, createInstallationToken, githubAppConfiguration, githubAppInstallUrl } from "../app/api/tasks/github-app.mjs";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
test("validates GitHub App configuration and install URLs", () => {
  assert.deepEqual(githubAppConfiguration({}), { configured: false, slug: null });
  const configuration = githubAppConfiguration({ ATLAS_GITHUB_APP_ID: "123", ATLAS_GITHUB_INSTALLATION_ID: "456", ATLAS_GITHUB_APP_PRIVATE_KEY: pem, ATLAS_GITHUB_APP_SLUG: "atlas-test" });
  assert.equal(configuration.configured, true);
  assert.equal(githubAppInstallUrl("atlas-test"), "https://github.com/apps/atlas-test/installations/new");
  assert.equal(githubAppInstallUrl("bad/value"), null);
});
test("creates a GitHub App JWT and installation token request", async () => {
  const configuration = githubAppConfiguration({ ATLAS_GITHUB_APP_ID: "123", ATLAS_GITHUB_INSTALLATION_ID: "456", ATLAS_GITHUB_APP_PRIVATE_KEY: pem });
  const jwt = await createGitHubAppJwt(configuration, 1_800_000_000_000);
  assert.equal(jwt.split(".").length, 3);
  const token = await createInstallationToken(configuration, async (url, init) => {
    assert.equal(url, "https://api.github.com/app/installations/456/access_tokens");
    assert.match(init.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
    assert.deepEqual(JSON.parse(init.body), { repositories: ["atlas"], permissions: { actions: "write" } });
    return new Response(JSON.stringify({ token: "github-installation-token-value" }), { status: 201 });
  });
  assert.equal(token, "github-installation-token-value");
});
test("a refused installation token names the step that failed, never the body", async () => {
  const configuration = githubAppConfiguration({ ATLAS_GITHUB_APP_ID: "123", ATLAS_GITHUB_INSTALLATION_ID: "456", ATLAS_GITHUB_APP_PRIVATE_KEY: pem });
  const refusal = (status, body = "") => async () => new Response(body, { status });
  const codeFor = async (status, body) => {
    try { await createInstallationToken(configuration, refusal(status, body)); } catch (error) { return { code: error.code, status: error.status, text: JSON.stringify(error) + error.message }; }
    return null;
  };
  // GitHub's answer when the App was never granted Actions: write.
  const missing = await codeFor(422, '{"message":"The permissions requested are not granted to this installation."}');
  assert.equal(missing.code, "GITHUB_APP_PERMISSION_MISSING");
  assert.doesNotMatch(missing.text, /not granted/u, "the body is not carried along");
  assert.equal((await codeFor(404)).code, "GITHUB_APP_INSTALLATION_NOT_FOUND");
  assert.equal((await codeFor(401)).code, "GITHUB_APP_KEY_REJECTED");
  assert.equal((await codeFor(500)).code, "GITHUB_APP_TOKEN_FAILED");
});
