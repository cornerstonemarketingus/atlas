import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { registerWorkflowTools } from "../src/agent/tools/workflow-tools.mjs";
import { registerCrmTools, HUBSPOT_CREDENTIAL } from "../src/agent/tools/crm-tools.mjs";
const token = "fixture-private-token";
function fixture({ policy = () => "allow", secret = token, discrepancy = false, failure = false } = {}) {
  let contact = null; let writes = 0; let lookups = 0; const requests = [];
  const registry = new ToolRegistry({ policy, secrets: async reference => { assert.equal(reference, HUBSPOT_CREDENTIAL); lookups++; return secret; } });
  registerCrmTools(registry, { fetchImpl: async (url, input) => {
    assert.equal(url.origin, "https://api.hubapi.com"); assert.equal(input.redirect, "error"); assert.equal(input.headers.authorization, `Bearer ${token}`);
    requests.push({ method: input.method, path: url.pathname });
    if (failure) return Response.json({ message: token }, { status: 403 });
    if (input.method === "POST") { writes++; const { properties } = JSON.parse(input.body); contact = { id: "123", properties: { ...properties, ...(discrepancy ? { firstname: "wrong" } : {}) } }; return Response.json({ id: "123" }); }
    return contact ? Response.json(contact) : Response.json({}, { status: 404 });
  } });
  const run = (name, input, approved = false, signal) => registry.invoke({ name, rawArguments: JSON.stringify(input), sessionId: "crm", approvals: { check: async () => approved }, signal, context: {} });
  return { registry, run, writes: () => writes, lookups: () => lookups, requests };
}
test("live workflow registration exposes CRM tools without granting capabilities", async () => {
  const registry = new ToolRegistry(); registerWorkflowTools(registry);
  assert.ok(registry.toModelTools().some(tool => tool.function.name === "crm.create_contact"));
  const denied = await registry.invoke({ name: "crm.create_contact", rawArguments: JSON.stringify({ email: "lead@example.invalid" }), sessionId: "s" });
  assert.equal(denied.code, "POLICY_DENIED");
});
test("contact approval and input validation precede credential lookup or external calls", async () => {
  const f = fixture(); const input = { email: "lead@example.invalid", firstname: "Sam" };
  const asked = await f.run("crm.create_contact", input);
  assert.equal(asked.status, "approval-required"); assert.equal(f.lookups(), 0); assert.equal(f.requests.length, 0);
  assert.equal((await f.run("crm.create_contact", { ...input, token }, true)).code, "INVALID_INPUT");
  assert.equal((await f.run("crm.create_contact", { email: "bad" }, true)).code, "INVALID_INPUT");
  assert.equal(f.lookups(), 0);
  const missing = fixture({ secret: null });
  assert.equal((await missing.run("crm.create_contact", input, true)).code, "MISSING_CREDENTIAL");
  assert.equal(missing.requests.length, 0);
});
test("approved contact creation requires independent matching read-back and reuses an existing email", async () => {
  const f = fixture(); const input = { email: "lead@example.invalid", firstname: "Sam", company: "Construction" };
  const saved = await f.run("crm.create_contact", input, true);
  assert.equal(saved.status, "completed"); assert.deepEqual(JSON.parse(saved.output), { created: true, verified: true, contactId: "123" });
  assert.deepEqual(f.requests.map(request => request.method), ["GET", "POST", "GET"]);
  const existing = await f.run("crm.create_contact", { ...input, firstname: "Changed" }, true);
  assert.equal(JSON.parse(existing.output).created, false); assert.match(existing.output, /No fields were changed/); assert.equal(f.writes(), 1);
  const found = await f.run("crm.find_contact", { email: input.email });
  assert.deepEqual(JSON.parse(found.output), { found: true, contactId: "123" });
  assert.equal(JSON.stringify([saved, existing, found]).includes(token), false);
});
test("unverified and denied writes fail honestly without retries or provider-body disclosure", async () => {
  const mismatch = fixture({ discrepancy: true });
  const failed = await mismatch.run("crm.create_contact", { email: "lead@example.invalid", firstname: "Sam" }, true);
  assert.equal(failed.code, "NOT_VERIFIED"); assert.equal(mismatch.writes(), 1);
  const denied = fixture({ failure: true });
  const refused = await denied.run("crm.create_contact", { email: "lead@example.invalid" }, true);
  assert.equal(refused.code, "NOT_AUTHORIZED"); assert.equal(denied.requests.length, 1); assert.equal(JSON.stringify(refused).includes(token), false);
});
test("cancelled contact work never reaches the provider", async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  const result = await f.run("crm.create_contact", { email: "lead@example.invalid" }, true, controller.signal);
  assert.notEqual(result.status, "completed"); assert.equal(f.requests.length, 0);
});
test("contact workflow crosses real HTTP transport and independently verifies stored contact", async t => {
  let contact = null; let writes = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") { let body = ""; for await (const chunk of request) body += chunk; writes++; contact = { id: "987", properties: JSON.parse(body).properties }; response.end(JSON.stringify({ id: "987" })); }
    else { response.statusCode = contact ? 200 : 404; response.end(JSON.stringify(contact ?? {})); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const registry = new ToolRegistry({ policy: () => "allow", secrets: () => token });
  registerCrmTools(registry, { fetchImpl: (url, input) => { assert.equal(url.origin, "https://api.hubapi.com"); return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, input); } });
  const result = await registry.invoke({ name: "crm.create_contact", rawArguments: JSON.stringify({ email: "inquiry@example.invalid", phone: "+15555550123" }), sessionId: "http", approvals: { check: async () => true }, context: {} });
  assert.equal(result.status, "completed"); assert.equal(JSON.parse(result.output).contactId, "987"); assert.equal(writes, 1);
});

test("cancellation during late credential resolution cannot start CRM network work", async () => {
  let release; let started; let calls = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const registry = new ToolRegistry({ policy: () => "allow", secrets: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  registerCrmTools(registry, { fetchImpl: async () => { calls++; return Response.json({}); } });
  const pending = registry.invoke({ name: "crm.create_contact", rawArguments: JSON.stringify({ email: "lead@example.invalid" }), sessionId: "late", signal: controller.signal, approvals: { check: async () => true }, context: {} });
  await ready; controller.abort(); release(token);
  const result = await pending;
  assert.notEqual(result.status, "completed"); assert.equal(calls, 0);
});
