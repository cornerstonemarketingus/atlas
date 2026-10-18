import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BusinessService } from "../src/agent/business-service.mjs";
import { registerBusinessTools } from "../src/agent/tools/business-tools.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { createLegacyPolicyBridge } from "../src/platform/legacy-policy-bridge.mjs";
import { createConversationExecutor } from "../src/agent/conversation-executor.mjs";
import { AgentRuntime } from "../src/agent/runtime.mjs";
import { AgentSessionStore } from "../src/agent/session-store.mjs";
import { createLocalControlServer } from "../src/server.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-business-tools-"));
  const store = new LocalTaskStore(join(directory, "local.sqlite"));
  let launches = 0;
  const service = new BusinessService({ filename: join(directory, "business.sqlite"), missionService: { create() { launches++; } } });
  const registry = new ToolRegistry({ policy: createLegacyPolicyBridge({ policyForCapability: capability => store.policy(capability) }) });
  registerBusinessTools(registry, () => service);
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const invoke = (name, rawArguments = {}, approvals = null) => registry.invoke({ name: `business.${name}`, rawArguments, sessionId: "session", approvals });
  return { directory, store, service, registry, invoke, cleanups, launches: () => launches };
}

test("business tools fail closed until configured and preserve exact approval digests", async t => {
  const { store, registry, invoke } = await fixture(t);
  assert.equal((await invoke("list")).code, "POLICY_DENIED");
  store.setPolicy("business.read", "ask");
  const pending = await invoke("list");
  assert.equal(pending.status, "approval-required");
  const wrong = await invoke("due", {}, { check: async digest => digest === pending.digest });
  assert.equal(wrong.status, "approval-required");
  assert.equal((await invoke("list", {}, { check: async digest => digest === pending.digest })).status, "completed");
  assert.deepEqual(registry.list().map(tool => tool.name), ["business.list", "business.inspect", "business.due", "business.plan"]);
  for (const name of ["create", "launch", "assign", "review"]) assert.equal((await invoke(name)).code, "UNKNOWN_TOOL");
});

test("business reads and both preparation previews return records without starting missions", async t => {
  const { store, service, invoke, launches } = await fixture(t);
  store.setPolicy("business.read", "allow");
  const business = service.create({ name: "Builder", objective: "Prepare customer pipeline" });
  const responsibility = service.assign(business.id, { owner: "owner", objective: "Review leads", successCriteria: ["Review evidence"], intervalMs: 60000 });
  assert.equal(JSON.parse((await invoke("list")).output).businesses[0].id, business.id);
  assert.equal(JSON.parse((await invoke("inspect", { businessId: business.id })).output).business.responsibilities[0].id, responsibility.id);
  assert.equal(JSON.parse((await invoke("due")).output).responsibilities[0].id, responsibility.id);
  for (const template of ["construction-launch", "self-improvement"]) {
    const result = await invoke("plan", { businessId: business.id, template });
    assert.equal(result.status, "completed");
    const output = JSON.parse(result.output);
    assert.equal(output.executed, false);
    assert.equal(output.plan.children.length, 5);
    assert.match(output.limitations.join(" "), /No hosting, CRM delivery, outreach/);
  }
  assert.equal(launches(), 0);
  assert.equal(service.get(business.id).responsibilities[0].lastReview, null);
});

test("strict business schemas reject invented arguments and unsupported templates", async t => {
  const { store, invoke } = await fixture(t);
  store.setPolicy("business.read", "allow");
  for (const [name, args] of [["list", { role: "admin" }], ["inspect", {}], ["inspect", { businessId: "../other" }], ["plan", { businessId: "id", template: "publish" }], ["plan", { businessId: "id", repository: "C:/repo" }]]) {
    assert.equal((await invoke(name, args)).code, "INVALID_INPUT");
  }
  assert.equal((await invoke("inspect", { businessId: "missing" })).code, "BUSINESS_NOT_FOUND");
});

test("owner policy opt-in reaches business tools through HTTP conversation; paired devices cannot opt in or send turns", async t => {
  const { directory, store, service, registry, cleanups } = await fixture(t);
  const business = service.create({ name: "Builder", objective: "Prepare a launch" });
  const seen = [];
  const client = { async *stream(request) {
    seen.push(request);
    if (seen.length === 1) yield { type: "tool_call", id: "business-call", name: "business.plan", arguments: JSON.stringify({ businessId: business.id }) };
    else yield { type: "text", delta: "Preparation preview only. No mission started." };
  } };
  const sessions = new AgentSessionStore(join(directory, "sessions.sqlite"));
  const runtime = new AgentRuntime({ sessions, executors: { conversation: createConversationExecutor({ client, registry }) } });
  const token = "0123456789abcdef0123456789abcdef";
  const server = createLocalControlServer({ store, token, runtime, businessService: service, runTask: async () => ({ ok: true }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.stop(); sessions.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers })).json();
  const { deviceToken } = await (await fetch(`${origin}/v1/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Phone" }) })).json();
  const device = { ...headers, authorization: `Bearer ${deviceToken}` };
  const policyBody = JSON.stringify({ capability: "business.read", decision: "allow" });
  assert.equal((await fetch(`${origin}/v1/policies`, { method: "PUT", headers: device, body: policyBody })).status, 403);
  assert.equal((await fetch(`${origin}/v1/policies`, { method: "PUT", headers, body: policyBody })).status, 200);
  const opened = await fetch(`${origin}/v1/sessions`, { method: "POST", headers, body: JSON.stringify({ title: "Business", model: "local", executor: "conversation" }) });
  const { session } = await opened.json();
  assert.ok(session?.id);
  const url = `${origin}/v1/sessions/${session.id}/turns`;
  assert.equal((await fetch(url, { method: "POST", headers: device, body: JSON.stringify({ text: "Launch business" }) })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ text: "Preview the business launch" }) })).status, 202);
  await runtime.drain();
  assert.equal(runtime.getSession(session.id).status, "completed");
  assert.ok(seen[0].tools.some(tool => tool.function.name === "business.plan"));
  assert.match(JSON.stringify(seen[1].messages), /Preparation preview only/);
  assert.equal((await fetch(`${origin}/v1/businesses/${business.id}`, { headers: device })).status, 200);
  const main = await readFile(new URL("../src/main.mjs", import.meta.url), "utf8");
  assert.match(main, /registerBusinessTools\(registry, \(\) => businessService\)/);
});
