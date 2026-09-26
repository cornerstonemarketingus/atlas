import assert from "node:assert/strict";
import test from "node:test";

import { addMembership, resolveTenant, tenantAllowlist } from "../db/tenancy.mjs";
import { allowedRepositories } from "../app/api/tasks/dispatch.mjs";
import { createGenesisRepository, genesisConfiguration, genesisNamespaceOwners, genesisProjectResponse } from "../app/api/projects/genesis/service.mjs";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";

const alice = { userId: "github:alice", dbUserId: 1 };
const bob = { userId: "github:bob", dbUserId: 2 };
const environment = {
  ATLAS_GITHUB_APP_ID: "123",
  ATLAS_GITHUB_INSTALLATION_ID: "456",
  ATLAS_GITHUB_APP_PRIVATE_KEY: "pem",
  ATLAS_GENESIS_REPOSITORY_OWNER: "acme",
  ATLAS_GENESIS_REPOSITORY_OWNER_TYPE: "org",
  ATLAS_DEFAULT_MERGE_POLICY: "manual",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Genesis configuration requires a configured owner namespace", () => {
  assert.equal(genesisConfiguration({ ...environment, ATLAS_GENESIS_REPOSITORY_OWNER: "" }).configured, false);
  assert.deepEqual(genesisNamespaceOwners(environment), ["acme"]);
});

test("creating a Genesis project seeds the repo through the GitHub API and adds it to the tenant allowlist", async () => {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"]] });
  const tenant = await resolveTenant(d1, alice);
  const calls = [];
  const request = new Request("https://atlas.test/api/projects/genesis", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Roofing CRM", template: "web-app", description: "CRM for roofing contractors" }),
  });
  const response = await genesisProjectResponse(request, {
    d1,
    tenant,
    githubToken: "github-installation-token-value",
    environment,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
      if (url === "https://api.github.com/orgs/acme/repos") {
        return json({ owner: { login: "acme" }, name: "roofing-crm", html_url: "https://github.com/acme/roofing-crm", default_branch: "main" }, 201);
      }
      if (String(url).endsWith("/git/blobs")) return json({ sha: `blob-${calls.length}` }, 201);
      if (String(url).endsWith("/git/trees")) return json({ sha: "tree-1" }, 201);
      if (String(url).endsWith("/git/commits")) return json({ sha: "commit-1" }, 201);
      if (String(url).endsWith("/git/refs")) return json({ ref: "refs/heads/main" }, 201);
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.repository, "acme/roofing-crm");
  assert.equal(calls[0].url, "https://api.github.com/orgs/acme/repos");
  assert.deepEqual(calls[0].body, { name: "roofing-crm", description: "CRM for roofing contractors", private: true, auto_init: false });
  const allowlist = await tenantAllowlist(d1, tenant.tenantId, allowedRepositories("cornerstonemarketingus/atlas"), { namespaceOwners: genesisNamespaceOwners(environment) });
  assert.deepEqual([...allowlist], ["acme/roofing-crm"]);
  assert.ok(calls.some((call) => String(call.url).endsWith("/git/trees")));
  assert.ok(calls.some((call) => String(call.url).endsWith("/git/commits")));
  assert.ok(calls.some((call) => String(call.url).endsWith("/git/refs")));
  sqlite.close();
});

test("Genesis creation is refused for non-admin workspace members", async () => {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"], [2, "bob"]] });
  const tenant = await resolveTenant(d1, alice);
  await addMembership(d1, { tenantId: tenant.tenantId, userId: 2, role: "member" });
  const memberTenant = { tenantId: tenant.tenantId, role: "member", principal: bob.userId };
  let called = false;
  const response = await genesisProjectResponse(new Request("https://atlas.test/api/projects/genesis", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "roofing-crm", template: "web-app", description: "CRM for roofing contractors" }),
  }), {
    d1,
    tenant: memberTenant,
    githubToken: "github-installation-token-value",
    environment,
    fetcher: async () => { called = true; return json({}, 201); },
  });
  assert.equal(response.status, 403);
  assert.equal(called, false);
  sqlite.close();
});

test("Genesis can target a user installation when configured", async () => {
  const calls = [];
  await createGenesisRepository({ name: "roofing-crm", template: "static-site", description: "CRM for roofing contractors" }, {
    configuration: genesisConfiguration({ ...environment, ATLAS_GENESIS_REPOSITORY_OWNER_TYPE: "user" }),
    githubToken: "github-installation-token-value",
    fetcher: async (url, init) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (url === "https://api.github.com/user/repos") return json({ owner: { login: "acme" }, name: "roofing-crm", default_branch: "main" }, 201);
      if (String(url).endsWith("/git/blobs")) return json({ sha: `blob-${calls.length}` }, 201);
      if (String(url).endsWith("/git/trees")) return json({ sha: "tree-1" }, 201);
      if (String(url).endsWith("/git/commits")) return json({ sha: "commit-1" }, 201);
      if (String(url).endsWith("/git/refs")) return json({ ref: "refs/heads/main" }, 201);
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(calls[0].url, "https://api.github.com/user/repos");
});
