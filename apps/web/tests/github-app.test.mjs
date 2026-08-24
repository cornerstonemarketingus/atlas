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
