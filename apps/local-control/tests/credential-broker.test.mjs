import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITIES, CredentialBroker, CredentialStore, classifyAuthFailure, credentialActionDigest } from "../src/agent/credentials/broker.mjs";
import { createAccountRoutes } from "../src/agent/credentials/routes.mjs";
import { cloudflareValidator, githubValidator } from "../src/agent/credentials/validators.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { createRedactor } from "../src/platform/terminal/redaction.mjs";

const SECRET = "cf-SECRET-token-value-0123456789abcdef";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

function memoryVault() {
  const values = new Map();
  return { values, get: async (name) => values.get(name) ?? null, set: async (name, value) => { values.set(name, value); }, delete: async (name) => { values.delete(name); } };
}

/** The daemon's approvals, in miniature: digest-bound, single use, decided by the owner. */
function ownerApprovals() {
  const pending = new Map();
  const approved = new Set();
  return {
    requests: [],
    request(request) { const approval = { id: `appr-${this.requests.length + 1}`, ...request }; this.requests.push(approval); pending.set(request.digest, approval); return approval; },
    check(digest) { if (!approved.has(digest)) return false; approved.delete(digest); return true; },
    approve(digest) { approved.add(digest); },
  };
}

function setup({ clock = () => new Date("2026-10-06T12:00:00Z") } = {}) {
  const store = new CredentialStore();
  const vault = memoryVault();
  const approvals = ownerApprovals();
  const broker = new CredentialBroker({ store, vault, approvals, clock });
  return { store, vault, approvals, broker };
}

test("a connection keeps its value only in the vault; listing never shows it", async () => {
  const { broker, vault } = setup();
  const account = await broker.connect({ provider: "cloudflare", account: ACCOUNT, type: "API_TOKEN", vaultRef: "CLOUDFLARE_AI_TOKEN", capabilities: ["cloudflare.ai.run"], secret: SECRET });
  assert.equal(vault.values.get("CLOUDFLARE_AI_TOKEN"), SECRET);
  assert.equal(account.credential, "stored in vault");
  assert.equal(account.vaultRef, undefined);
  assert.doesNotMatch(JSON.stringify(broker.connections()), /SECRET/u);
  await assert.rejects(broker.connect({ provider: "cloudflare", account: ACCOUNT, type: "API_TOKEN", vaultRef: "X_TOKEN", capabilities: ["github.repo.read"] }), /not a cloudflare capability/u);
  await assert.rejects(broker.connect({ provider: "cloudflare", account: ACCOUNT, type: "PLAINTEXT", vaultRef: "X_TOKEN" }), /Credential type/u);
  await assert.rejects(broker.connect({ provider: "cloudflare", account: ACCOUNT, type: "API_TOKEN", vaultRef: "X_TOKEN", capabilities: ["cloudflare.fly"] }), /Unknown capability/u);
});

test("an agent gets a lease for a granted capability and the adapter alone sees the secret; results are redacted", async () => {
  const { broker } = setup();
  await broker.connect({ provider: "cloudflare", account: ACCOUNT, type: "API_TOKEN", vaultRef: "CLOUDFLARE_AI_TOKEN", capabilities: ["cloudflare.ai.run"], secret: SECRET });
  const request = await broker.request({ agentId: "chat", capability: "cloudflare.ai.run", resource: "@cf/openai/gpt-oss-120b" });
  assert.equal(request.status, "granted", "level 1 runs without asking in Balanced mode");
  assert.doesNotMatch(JSON.stringify(request), /SECRET/u, "the lease never carries the credential");
  let seen = null;
  const result = await broker.use(request.lease.id, { capability: "cloudflare.ai.run", resource: "@cf/openai/gpt-oss-120b" }, async ({ secret, connection }) => {
    seen = secret;
    assert.equal(connection.account, ACCOUNT);
    return { answer: "OK", echoed: `Bearer ${secret}` };
  });
  assert.equal(seen, SECRET);
  assert.deepEqual(result, { answer: "OK", echoed: "Bearer [redacted:credential]" });
  await assert.rejects(broker.use(request.lease.id, { capability: "cloudflare.ai.run", resource: "@cf/openai/gpt-oss-120b" }, async () => "again"), (error) => error.code === "LEASE_INVALID", "a lease is single use");
  const trail = broker.auditTrail();
  assert.deepEqual(trail.map((entry) => entry.decision), ["refused", "used", "granted"], "newest first: the replay refused, the use, the grant");
  assert.ok(trail.some((entry) => entry.decision === "used" && entry.credentialRef === "CLOUDFLARE_AI_TOKEN" && entry.result === "OK" && entry.agent === "chat"));
  assert.doesNotMatch(JSON.stringify(trail), /SECRET/u, "the audit trail names the reference, never the value");
});

test("a lease is bound to its capability, resource and lifetime", async () => {
  let now = new Date("2026-10-06T12:00:00Z");
  const { broker } = setup({ clock: () => now });
  await broker.connect({ provider: "cloudflare", account: ACCOUNT, type: "API_TOKEN", vaultRef: "CLOUDFLARE_AI_TOKEN", capabilities: ["cloudflare.ai.run"], secret: SECRET });
  const lease = (await broker.request({ agentId: "chat", capability: "cloudflare.ai.run", resource: "model-a" })).lease;
  await assert.rejects(broker.use(lease.id, { capability: "cloudflare.ai.run", resource: "model-b" }, async () => "x"), (error) => error.code === "LEASE_INVALID");
  const late = (await broker.request({ agentId: "chat", capability: "cloudflare.ai.run", resource: "model-a" })).lease;
  now = new Date(now.getTime() + 6 * 60_000);
  await assert.rejects(broker.use(late.id, { capability: "cloudflare.ai.run", resource: "model-a" }, async () => "x"), (error) => error.code === "LEASE_INVALID", "an expired lease");
});

test("refusals are classified: missing, wrong account, capability not granted, expired, revoked, unknown capability", async () => {
  let now = new Date("2026-10-06T12:00:00Z");
  const { broker, vault } = setup({ clock: () => now });
  assert.equal((await broker.request({ agentId: "a", capability: "cloudflare.ai.run" })).code, "CREDENTIAL_MISSING");
  assert.equal((await broker.request({ agentId: "a", capability: "cloudflare.fly" })).code, "UNKNOWN_CAPABILITY");
  const account = await broker.connect({ provider: "cloudflare", account: ACCOUNT, type: "API_TOKEN", vaultRef: "CLOUDFLARE_AI_TOKEN", capabilities: ["cloudflare.ai.run"], expiresAt: "2026-10-07T00:00:00Z", secret: SECRET });
  assert.equal((await broker.request({ agentId: "a", capability: "cloudflare.ai.run", account: "ffffffffffffffffffffffffffffffff" })).code, "WRONG_ACCOUNT", "a credential that exists for another account is named as such");
  assert.equal((await broker.request({ agentId: "a", capability: "cloudflare.workers.deploy" })).code, "CAPABILITY_NOT_GRANTED");

  // The value vanishing from the vault is caught when it is used.
  const lease = (await broker.request({ agentId: "a", capability: "cloudflare.ai.run" })).lease;
  vault.values.delete("CLOUDFLARE_AI_TOKEN");
  await assert.rejects(broker.use(lease.id, { capability: "cloudflare.ai.run", resource: "" }, async () => "x"), (error) => error.code === "CREDENTIAL_MISSING");

  now = new Date("2026-10-08T00:00:00Z");
  assert.equal((await broker.request({ agentId: "a", capability: "cloudflare.ai.run" })).code, "CREDENTIAL_EXPIRED");
  assert.equal(broker.connections()[0].status, "expired");
  await broker.revoke(account.id);
  assert.equal(broker.connections()[0].status, "revoked");
});

test("approval modes: Safe asks for external changes, Balanced remembers an approved capability, production always asks", async () => {
  const { broker, approvals } = setup();
  const github = await broker.connect({ provider: "github", account: "octo", type: "API_TOKEN", vaultRef: "GITHUB_TOKEN_OCTO", capabilities: ["github.repo.read", "github.repo.write", "github.pr.create", "github.pr.merge"], secret: "ghp_SECRETSECRETSECRETSECRETSECRET1234" });
  assert.equal(broker.mode, "BALANCED");
  assert.equal((await broker.request({ agentId: "coder", capability: "github.repo.write", resource: "octo/app" })).status, "granted", "a restorable change in Balanced");

  const first = await broker.request({ agentId: "coder", capability: "github.pr.create", resource: "octo/app" });
  assert.equal(first.status, "approval-required", "a new external capability asks");
  assert.equal(first.digest, credentialActionDigest({ agentId: "coder", capability: "github.pr.create", connectionId: github.id, resource: "octo/app" }));
  assert.equal(approvals.requests[0].riskLevel, 3);
  assert.doesNotMatch(JSON.stringify(approvals.requests), /SECRET/u);

  // An approval for one action cannot be spent on another.
  approvals.approve(first.digest);
  assert.equal((await broker.request({ agentId: "coder", capability: "github.pr.create", resource: "octo/other" })).status, "approval-required", "another resource is another action");
  assert.equal((await broker.request({ agentId: "coder", capability: "github.pr.create", resource: "octo/app" })).status, "granted");
  assert.equal((await broker.request({ agentId: "coder", capability: "github.pr.create", resource: "octo/app" })).status, "granted", "Balanced remembers the approved capability");

  const merge = await broker.request({ agentId: "coder", capability: "github.pr.merge", resource: "octo/app#1" });
  assert.equal(merge.status, "approval-required");
  approvals.approve(merge.digest);
  assert.equal((await broker.request({ agentId: "coder", capability: "github.pr.merge", resource: "octo/app#1" })).status, "granted");
  assert.equal((await broker.request({ agentId: "coder", capability: "github.pr.merge", resource: "octo/app#1" })).status, "approval-required", "level 4 asks every time, even after an approval");

  broker.setMode("SAFE");
  assert.equal((await broker.request({ agentId: "coder", capability: "github.repo.write", resource: "octo/app" })).status, "approval-required", "Safe asks before any external change");
  assert.equal((await broker.request({ agentId: "coder", capability: "github.repo.read", resource: "octo/app" })).status, "granted", "reads never ask");
  broker.setMode("AUTONOMOUS");
  assert.equal((await broker.request({ agentId: "coder", capability: "github.pr.create", resource: "octo/new" })).status, "granted", "Autonomous acts within granted capabilities");
  assert.equal((await broker.request({ agentId: "coder", capability: "github.pr.merge", resource: "octo/app#2" })).status, "approval-required", "Autonomous is never unrestricted");
  assert.throws(() => broker.setMode("ROOT"), /Approval mode/u);
});

test("provider failures are classified, and a Cloudflare 401 with error 10000 is not called an invalid token", () => {
  assert.equal(classifyAuthFailure({ provider: "cloudflare", status: 401, codes: [10000] }), "WRONG_ACCOUNT");
  assert.equal(classifyAuthFailure({ provider: "cloudflare", status: 403, codes: [10000] }), "INSUFFICIENT_PERMISSION");
  assert.equal(classifyAuthFailure({ provider: "cloudflare", status: 401, codes: [1000] }), "CREDENTIAL_INVALID");
  assert.equal(classifyAuthFailure({ provider: "github", status: 401 }), "CREDENTIAL_INVALID");
  assert.equal(classifyAuthFailure({ provider: "github", status: 403 }), "INSUFFICIENT_PERMISSION");
  assert.equal(classifyAuthFailure({ status: 429 }), "PROVIDER_RATE_LIMIT");
  assert.equal(classifyAuthFailure({ status: 402 }), "BILLING_EXHAUSTED");
  assert.equal(classifyAuthFailure({ status: 503 }), "PROVIDER_UNAVAILABLE");
});

test("validation records the provider's verdict and detects a credential for another account", async () => {
  const { broker } = setup();
  const github = await broker.connect({ provider: "github", account: "octo", type: "API_TOKEN", vaultRef: "GITHUB_TOKEN_OCTO", capabilities: ["github.repo.read"], secret: "ghp_SECRETSECRETSECRETSECRETSECRET1234" });
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, authorization: init.headers.authorization }); return Response.json({ login: "someone-else" }); };
  const checked = await broker.validate(github.id, githubValidator({ fetcher }));
  assert.equal(checked.lastValidation.category, "WRONG_ACCOUNT");
  assert.equal(checked.lastValidation.reportedAccount, "someone-else");
  assert.equal(checked.status, "attention");
  assert.equal(calls[0].url, "https://api.github.com/user");

  const ok = await broker.validate(github.id, githubValidator({ fetcher: async () => Response.json({ login: "octo" }) }));
  assert.equal(ok.lastValidation.category, "OK");
  assert.equal(ok.status, "connected");
  const invalid = await broker.validate(github.id, githubValidator({ fetcher: async () => new Response("{}", { status: 401 }) }));
  assert.equal(invalid.lastValidation.category, "CREDENTIAL_INVALID");

  const cloudflare = await broker.connect({ provider: "cloudflare", account: ACCOUNT, type: "API_TOKEN", vaultRef: "CLOUDFLARE_AI_TOKEN", capabilities: ["cloudflare.ai.run"], secret: SECRET });
  const cf = (routes) => async (url) => routes[new URL(url).pathname.replace("/client/v4", "").replace(ACCOUNT, "{a}")]();
  const verified = () => Response.json({ success: true, result: { status: "active" } });
  const denied = () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 401 });
  assert.equal((await broker.validate(cloudflare.id, cloudflareValidator({ accountId: ACCOUNT, fetcher: cf({ "/user/tokens/verify": verified, "/accounts/{a}/ai/models/search": () => Response.json({ success: true }) }) }))).lastValidation.category, "OK");
  assert.equal((await broker.validate(cloudflare.id, cloudflareValidator({ accountId: ACCOUNT, fetcher: cf({ "/user/tokens/verify": verified, "/accounts/{a}/ai/models/search": denied }) }))).lastValidation.category, "WRONG_ACCOUNT");
  assert.equal((await broker.validate(cloudflare.id, cloudflareValidator({ accountId: ACCOUNT, fetcher: cf({ "/user/tokens/verify": () => Response.json({ success: true, result: { status: "expired" } }) }) }))).lastValidation.category, "CREDENTIAL_EXPIRED");
  assert.doesNotMatch(JSON.stringify(broker.connections()), /SECRET/u);
});

test("the audit trail is append-only, even to code with the database open", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const directory = mkdtempSync(join(tmpdir(), "atlas-credentials-"));
  const file = join(directory, "credentials.sqlite");
  const store = new CredentialStore(file);
  store.audit({ at: "2026-10-06T00:00:00Z", agent: "a", capability: "github.repo.read", decision: "granted" });
  store.close();
  const raw = new DatabaseSync(file);
  try {
    assert.throws(() => raw.exec("UPDATE credential_audit SET decision = 'denied'"), /append-only/u);
    assert.throws(() => raw.exec("DELETE FROM credential_audit"), /append-only/u);
  } finally {
    raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("credentials never reach the model: tool outputs and errors pass the redactor at the registry boundary", async () => {
  const { broker } = setup();
  await broker.connect({ provider: "cloudflare", account: ACCOUNT, type: "API_TOKEN", vaultRef: "CLOUDFLARE_AI_TOKEN", capabilities: ["cloudflare.ai.run"], secret: SECRET });
  const lease = (await broker.request({ agentId: "chat", capability: "cloudflare.ai.run" })).lease;
  await broker.use(lease.id, { capability: "cloudflare.ai.run", resource: "" }, async () => "ok");
  const redact = (text) => createRedactor({ knownSecrets: broker.knownSecrets() })(text).text;
  const registry = new ToolRegistry({ policy: () => "allow", redact });
  registry.register({
    name: "debug.echo", description: "echo", capability: "debug.echo", risk: "low", requiresApproval: false,
    inputSchema: { type: "object", properties: { fail: { type: "boolean" } } }, timeoutMs: 1000, maxOutputCharacters: 2000,
    execute: async ({ input }) => { if (input.fail) throw new Error(`call failed with ${SECRET}`); return `token=${SECRET} and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123`; },
  });
  const output = await registry.invoke({ name: "debug.echo", rawArguments: {}, sessionId: "s" });
  assert.doesNotMatch(output.output, /SECRET|ghp_ABCD/u);
  const failed = await registry.invoke({ name: "debug.echo", rawArguments: { fail: true }, sessionId: "s" });
  assert.doesNotMatch(failed.message, /SECRET/u);
});

test("over HTTP: owners connect, check and revoke; devices only read; no response carries the credential", async () => {
  const { broker } = setup();
  const sent = [];
  const send = (_response, status, body) => { sent.push({ status, body }); return true; };
  const routes = createAccountRoutes({ broker, capabilities: CAPABILITIES, validators: { github: () => async () => ({ category: "OK", account: "octo" }) }, send });
  const call = async (method, url, body, role = "admin") => {
    const request = { method, url, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    await routes(request, {}, { role });
    return sent.at(-1);
  };
  assert.equal((await call("POST", "/v1/accounts", { provider: "github", account: "octo", type: "API_TOKEN", vaultRef: "GITHUB_TOKEN_OCTO", capabilities: ["github.repo.read"], secret: "ghp_SECRETSECRETSECRETSECRETSECRET1234" }, "device")).status, 403);
  const created = await call("POST", "/v1/accounts", { provider: "github", account: "octo", type: "API_TOKEN", vaultRef: "GITHUB_TOKEN_OCTO", capabilities: ["github.repo.read"], secret: "ghp_SECRETSECRETSECRETSECRETSECRET1234" });
  assert.equal(created.status, 201);
  const listed = await call("GET", "/v1/accounts", null, "device");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.accounts.length, 1);
  assert.equal(listed.body.mode, "BALANCED");
  assert.equal((await call("GET", "/v1/accounts/audit", null, "device")).status, 403);
  assert.equal((await call("POST", `/v1/accounts/${created.body.account.id}/validate`)).body.account.lastValidation.category, "OK");
  assert.equal((await call("PUT", "/v1/accounts/mode", { mode: "SAFE" })).body.mode, "SAFE");
  assert.equal((await call("PUT", "/v1/accounts/mode", { mode: "ROOT" })).status, 400);
  assert.equal((await call("DELETE", `/v1/accounts/${created.body.account.id}`)).body.account.status, "revoked");
  assert.doesNotMatch(JSON.stringify(sent), /SECRET/u);
});

test("a vault that refuses is a clear 503, never a crash, and no record is left behind", async () => {
  const store = new CredentialStore();
  const vault = { get: async () => null, set: async () => { const error = new Error("The system keyring refused the credential: spawn secret-tool ENOENT"); error.name = "VaultError"; error.code = "VAULT_WRITE_FAILED"; throw error; } };
  const broker = new CredentialBroker({ store, vault });
  const sent = [];
  const routes = createAccountRoutes({ broker, capabilities: CAPABILITIES, send: (_response, status, body) => { sent.push({ status, body }); return true; } });
  const body = { provider: "github", account: "octo", type: "API_TOKEN", vaultRef: "GITHUB_TOKEN_OCTO", capabilities: ["github.repo.read"], secret: "ghp_SECRETSECRETSECRETSECRETSECRET1234" };
  await routes({ method: "POST", url: "/v1/accounts", async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }, {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 503);
  assert.equal(sent.at(-1).body.code, "VAULT_WRITE_FAILED");
  assert.equal(broker.connections().length, 0, "nothing registered without its value");
  assert.doesNotMatch(JSON.stringify(sent), /SECRET/u);
});
