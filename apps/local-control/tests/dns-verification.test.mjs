import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareAdapter } from "../src/agent/infrastructure/cloudflare.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { registerInfrastructureTools } from "../src/agent/tools/infrastructure-tools.mjs";
function fixture(observed) {
  let written = null; let writes = 0;
  const adapter = createCloudflareAdapter({ token: "fixture-only", fetchImpl: async (_url, input) => {
    if (input.method === "POST") { written = JSON.parse(input.body); writes++; return Response.json({ result: { id: "record", ...written } }); }
    return Response.json({ result: written ? [{ id: "record", ...written, ...observed }] : [] });
  } });
  return { adapter, writes: () => writes };
}
for (const observed of [{ ttl: 600 }, { proxied: false }, { name: "other.example.invalid" }, { content: "203.0.113.99" }]) {
  test(`DNS apply refuses a provider read-back discrepancy: ${JSON.stringify(observed)}`, async () => {
    const { adapter, writes } = fixture(observed);
    const plan = await adapter.planDnsRecord({ zoneId: "zone", type: "A", name: "www.example.invalid", content: "203.0.113.50", ttl: 1, proxied: true });
    const result = await adapter.applyDnsRecord({ zoneId: "zone", plan });
    assert.equal(result.verified, false);
    assert.equal(writes(), 1, "verification never replays the mutation");
    for (const [key, value] of Object.entries(observed)) assert.equal(result.observed[key], value);
  });
}
test("DNS verification accepts matching state with provider-normalized domain casing and root dot", async () => {
  const { adapter } = fixture({ name: "www.example.invalid" });
  const plan = await adapter.planDnsRecord({ zoneId: "zone", type: "A", name: "WWW.EXAMPLE.INVALID.", content: "203.0.113.50", ttl: 300, proxied: false });
  assert.equal((await adapter.applyDnsRecord({ zoneId: "zone", plan })).verified, true);
});
test("the approved infrastructure tool reports failed verification when the proxy state was not applied", async () => {
  const { adapter, writes } = fixture({ proxied: false });
  const registry = new ToolRegistry({ policy: () => "allow" });
  registerInfrastructureTools(registry, { providers: { cloudflare: adapter }, vault: {} });
  const run = (name, args) => registry.invoke({ name, rawArguments: JSON.stringify(args), sessionId: "dns-readback", approvals: { check: async () => true }, context: {} });
  const planned = await run("infrastructure.plan", { resource: "dns_record", zoneId: "zone", recordType: "A", name: "www.example.invalid", content: "203.0.113.50", ttl: 1, proxied: true });
  assert.equal(planned.status, "completed");
  const plan = /Plan: ([0-9a-f]{64})/u.exec(planned.output)[1];
  const applied = await run("infrastructure.apply", { plan });
  assert.equal(applied.status, "failed"); assert.equal(applied.code, "NOT_VERIFIED");
  assert.match(applied.message, /could not be confirmed/);
  assert.equal(writes(), 1);
});
