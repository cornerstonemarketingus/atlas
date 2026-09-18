import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInfrastructureAdmin } from "../src/infrastructure-adapters.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("Cloudflare DNS plans redact values, verify changes, and never put credentials in URLs", async () => {
  const calls = [];
  const infrastructure = createInfrastructureAdmin({
    resolveSecret: async (reference) => reference === "env:CLOUDFLARE_TOKEN" ? "cf-secret-token" : assert.fail("unexpected secret reference"),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (!options.method) {
        if (String(url).includes("?")) return json({ success: true, result: [] });
        return json({ success: true, result: { id: "record-1", type: "A", name: "app.example.com", content: "192.0.2.10" } });
      }
      return json({ success: true, result: { id: "record-1" } });
    },
  });
  const plan = infrastructure.preview("cloudflare.dns.upsert", { credentialRef: "env:CLOUDFLARE_TOKEN", zoneId: "zone-1", type: "A", name: "app.example.com", content: "192.0.2.10" });
  assert.equal(JSON.stringify(plan.preview).includes("192.0.2.10"), false);
  assert.equal(JSON.stringify(plan.preview).includes("cf-secret-token"), false);
  const receipt = await infrastructure.execute(plan);
  assert.equal(receipt.verified, true);
  assert.equal(calls.every((call) => !call.url.includes("cf-secret-token")), true);
  assert.equal(calls.every((call) => call.options.headers.authorization === "Bearer cf-secret-token"), true);
});

test("Vercel environment values are resolved locally only when executing", async () => {
  const resolved = [], calls = [];
  const infrastructure = createInfrastructureAdmin({
    resolveSecret: async (reference) => { resolved.push(reference); return reference.endsWith("TOKEN") ? "vercel-token" : "super-secret-value"; },
    fetchImpl: async (url, options = {}) => { calls.push({ url: String(url), options }); return options.method ? json({ created: { id: "env-1" } }) : json({ id: "env-1", key: "API_KEY" }); },
  });
  const plan = infrastructure.preview("vercel.environment.upsert", { credentialRef: "env:VERCEL_TOKEN", valueRef: "vault:ATLAS_API_VALUE", projectId: "project-1", key: "API_KEY", targets: ["production"] });
  assert.deepEqual(resolved, []);
  assert.equal(JSON.stringify(plan.preview).includes("super-secret-value"), false);
  await infrastructure.execute(plan);
  assert.deepEqual(resolved.sort(), ["env:VERCEL_TOKEN", "vault:ATLAS_API_VALUE"]);
  assert.equal(calls[0].url.includes("super-secret-value"), false);
  assert.equal(JSON.parse(calls[0].options.body).value, "super-secret-value");
});

test("Vercel deployment creation is exact, verified, and team scoped", async () => {
  const calls = [];
  const infrastructure = createInfrastructureAdmin({
    resolveSecret: async () => "vercel-token",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return options.method ? json({ id: "deploy-1" }) : json({ id: "deploy-1", readyState: "QUEUED" });
    },
  });
  const plan = infrastructure.preview("vercel.deployment.create", { credentialRef: "env:VERCEL_TOKEN", projectId: "project-1", teamId: "team-1", name: "atlas", target: "production", gitSource: { type: "github", repoId: "1234", ref: "main" } });
  const receipt = await infrastructure.execute(plan);
  assert.deepEqual({ verified: receipt.verified, state: receipt.state }, { verified: true, state: "QUEUED" });
  assert.equal(calls.every((call) => new URL(call.url).searchParams.get("teamId") === "team-1"), true);
  assert.deepEqual(JSON.parse(calls[0].options.body).gitSource, { type: "github", ref: "main", repoId: "1234" });
});

test("local API requires an exact one-use approval before infrastructure execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-infrastructure-"));
  const store = new LocalTaskStore(join(directory, "test.sqlite"));
  let executions = 0;
  const infrastructure = {
    preview: (action) => ({ id: "11111111-1111-4111-8111-111111111111", action, digest: "a".repeat(64), capability: "infrastructure.dns.write", preview: { action, content: "[redacted]" }, input: { credentialRef: "env:CLOUDFLARE_TOKEN" }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    execute: async () => { executions += 1; return { ok: true, verified: true }; },
  };
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true }), infrastructure });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const created = await fetch(`${origin}/v1/infrastructure/preview`, { method: "POST", headers, body: JSON.stringify({ action: "cloudflare.dns.upsert", input: {} }) });
  assert.equal(created.status, 201); const { plan } = await created.json(); assert.equal("input" in plan, false);
  assert.equal((await fetch(`${origin}/v1/infrastructure/plans/${plan.id}/execute`, { method: "POST", headers })).status, 409);
  assert.equal(executions, 0);
  const decision = await fetch(`${origin}/v1/approvals/${plan.approvalId}/decision`, { method: "POST", headers, body: JSON.stringify({ decision: "approved" }) });
  assert.equal(decision.status, 200);
  assert.equal((await fetch(`${origin}/v1/infrastructure/plans/${plan.id}/execute`, { method: "POST", headers })).status, 200);
  assert.equal(executions, 1);
  assert.equal((await fetch(`${origin}/v1/infrastructure/plans/${plan.id}/execute`, { method: "POST", headers })).status, 409);
  assert.equal(executions, 1);
  assert.ok(store.auditEvents().some((event) => event.category === "infrastructure.completed"));
});

test("invalid destinations and raw secret values fail closed", () => {
  const infrastructure = createInfrastructureAdmin({ resolveSecret: async () => "secret" });
  assert.throws(() => infrastructure.preview("vercel.environment.upsert", { credentialRef: "raw-token", valueRef: "env:VALUE", projectId: "p", key: "KEY", targets: ["production"] }), /credential reference/u);
  assert.throws(() => infrastructure.preview("cloudflare.dns.delete", {}), /Unsupported/u);
  assert.throws(() => infrastructure.preview("cloudflare.dns.upsert", { credentialRef: "env:CF_TOKEN", zoneId: "zone", type: "A", name: "not a host!", content: "192.0.2.1" }), /hostname/u);
});

function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
