import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FreeLocalSetup } from "../src/agent/models/free-local.mjs";
import { freeLocalChoices } from "../src/agent/models/catalog.mjs";
import { ModelPlanStore } from "../src/agent/models/hosting.mjs";
import { createGateway } from "../../../scripts/local/model-gateway.mjs";
import { localCoderEnvironment } from "../src/runner.mjs";

const hardware = { totalMemoryGiB: 8, usableModelMemoryGiB: 8, freeMemoryGiB: 5, freeDiskGiB: 30, accelerator: "cpu", gpus: [] };
function capableReply(_url, init) {
  const body = JSON.parse(init.body);
  const prompt = body.messages[0].content;
  const delta = body.tools ? { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup_weather", arguments: '{"city":"Oslo"}' } }] }
    : { content: prompt.includes('"country"') ? '{"city":"Oslo","country":"Norway"}' : prompt.match(/\d+-ALPHA/)?.[0] ?? "READY" };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-free-local-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const planStore = new ModelPlanStore(join(dir, "plan.json"));
  const values = new Map();
  let online = true;
  const manager = { status: async () => ({ reachable: online, installed: [{ tag: "qwen3:1.7b" }], loaded: [] }),
    ensureServer: async () => {}, warm: async () => {}, reachable: async () => online };
  const setup = new FreeLocalSetup({ manager, planStore, vault: { get: async (key) => values.get(key) ?? null, set: async (key, value) => values.set(key, value) },
    detectHardware: async () => hardware, port: 0, codingProbe: async () => ({ passed: true }), gatewayFactory: (options) => createGateway({ ...options, fetcher: async (...args) => capableReply(...args) }), ...overrides });
  t.after(() => setup.close());
  return { setup, manager, planStore, values, offline: () => { online = false; } };
}

test("recommendations account for headroom, context, disk and CPU speed", () => {
  const choices = freeLocalChoices(hardware);
  assert.equal(choices.balanced.tag, "qwen3:1.7b");
  assert.ok(choices.best.coding >= choices.balanced.coding);
  assert.equal(choices.balanced.context, 4096);
  assert.equal(freeLocalChoices({ ...hardware, freeDiskGiB: 0 }).balanced, null);
  assert.equal(freeLocalChoices({ ...hardware, freeDiskGiB: null }).balanced, null);
  assert.equal(freeLocalChoices({ ...hardware, freeDiskGiB: null }, ["qwen3:1.7b"]).balanced.tag, "qwen3:1.7b");
  assert.equal(freeLocalChoices({ ...hardware, requiredContextTokens: 7000 }).balanced.tag, "qwen3:1.7b");
  assert.equal(freeLocalChoices({ ...hardware, totalMemoryGiB: 3, usableModelMemoryGiB: 3 }).best, null);
});

test("setup verifies the real HTTP streaming boundary before persisting; secrets never enter status", async (t) => {
  const { setup, planStore, values } = fixture(t);
  setup.start();
  await setup.promise;
  assert.equal(setup.job.state, "ready");
  assert.equal(planStore.read().freeLocal, true);
  assert.equal(planStore.read().cloudFallback, false);
  const credential = values.get("FREE_LOCAL_GATEWAY_KEY");
  assert.ok(credential.length >= 32);
  assert.ok(!JSON.stringify(await setup.overview()).includes(credential));
  assert.throws(() => setup.start("../bad"));
});

test("local-only activation identifies the serving model and never calls paid fallback when offline", async (t) => {
  const { setup, offline } = fixture(t);
  setup.start(); await setup.promise;
  let paidCalls = 0;
  let served;
  const client = setup.client({ async *stream() { paidCalls += 1; yield { type: "text", delta: "paid" }; } }, (route) => { served = route; });
  const request = { model: "cloud-model", messages: [{ role: "user", content: "hello" }] };
  const result = [];
  for await (const event of client.stream(request)) result.push(event);
  assert.equal(result[0].delta, "READY");
  assert.deepEqual(served, { provider: "local", model: "qwen3:1.7b", paid: false });
  offline();
  await assert.rejects(async () => { for await (const event of client.stream(request)) void event; }, /offline/);
  assert.equal(paidCalls, 0);
});

test("coding executor receives the selected context and authenticated gateway only through its private environment", async (t) => {
  const { setup, values, offline } = fixture(t);
  setup.start(); await setup.promise;
  const configuration = await setup.coderConfiguration();
  assert.equal(configuration.model, "qwen3:1.7b");
  assert.equal(configuration.context, 4096);
  assert.equal(new URL(configuration.baseUrl).hostname, "127.0.0.1");
  assert.equal(localCoderEnvironment(configuration).ATLAS_LOCAL_MODEL_KEY, values.get("FREE_LOCAL_GATEWAY_KEY"));
  assert.ok(!JSON.stringify(await setup.overview()).includes(configuration.apiKey));
  offline();
  await assert.rejects(setup.coderConfiguration(), /offline/);
});

test("insufficient memory and invalid streams cannot activate a plan", async (t) => {
  const low = fixture(t, { detectHardware: async () => ({ ...hardware, freeMemoryGiB: 0.2 }) });
  low.setup.start(); await low.setup.promise;
  assert.equal(low.setup.job.code, "INSUFFICIENT_MEMORY");
  assert.equal(low.planStore.read(), null);
  const empty = fixture(t, { gatewayFactory: (options) => createGateway({ ...options, fetcher: async () => new Response('data: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) }) });
  empty.setup.start(); await empty.setup.promise;
  assert.equal(empty.setup.job.state, "failed");
  assert.equal(empty.planStore.read(), null);
});

test("a prose-only coding run cannot activate Free Local AI even when tool formatting passes", async (t) => {
  const { setup, planStore } = fixture(t, { codingProbe: async () => ({ passed: false, completed: true, patchVerified: false }) });
  setup.start(); await setup.promise;
  assert.equal(setup.job.code, "CAPABILITY_FAILED");
  assert.equal(planStore.read(), null);
  assert.equal(setup.gateway, null);
});

test("persisted plans fail closed on malicious names or malformed fallback policy", (t) => {
  const { planStore } = fixture(t);
  writeFileSync(planStore.path, JSON.stringify({ coder: { tag: "bad;cmd", context: 8192 } }));
  assert.equal(planStore.read(), null);
  writeFileSync(planStore.path, JSON.stringify({ freeLocal: true, cloudFallback: "yes", coder: { tag: "qwen2.5-coder:1.5b", context: 8192 } }));
  assert.equal(planStore.read(), null);
});

test("explicit fallback preference survives persistence and identifies the actual cloud model", async (t) => {
  const { setup, offline, planStore } = fixture(t);
  setup.start(); await setup.promise;
  assert.equal(planStore.read().cloudFallback, false);
  setup.setFallback(true);
  assert.equal(planStore.read().cloudFallback, true);
  offline();
  let served;
  const fallback = { endpoint: "https://cloud.example", async *stream(request) {
    request.onRoute({ endpoint: "https://cloud.example/v1", model: "actual-cloud-model" });
    yield { type: "text", delta: "cloud answer" };
  } };
  const client = setup.client(fallback, (route) => { served = route; });
  const result = [];
  for await (const event of client.stream({ model: "requested-model", messages: [{ role: "user", content: "hello" }] })) result.push(event);
  assert.equal(result[0].delta, "cloud answer");
  assert.deepEqual(served, { provider: "cloud", model: "actual-cloud-model", paid: true, failedOver: true });
  setup.setFallback(false);
  assert.equal((await setup.overview()).cloudFallback, false);
});

test("declared tool support is not enough: a prose-only model cannot activate", async (t) => {
  const { setup, planStore } = fixture(t, { gatewayFactory: (options) => createGateway({ ...options, fetcher: async () => new Response('data: {"choices":[{"delta":{"content":"READY"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) }) });
  setup.start(); await setup.promise;
  assert.equal(setup.job.code, "CAPABILITY_FAILED");
  assert.equal(planStore.read(), null);
  assert.equal(setup.gateway, null);
});

test("restart restores the applied model and reuses the OS-vault credential", async (t) => {
  const { setup, values } = fixture(t);
  setup.start(); await setup.promise;
  const credential = values.get("FREE_LOCAL_GATEWAY_KEY");
  await setup.close();
  assert.equal((await setup.overview()).online, false);
  setup.resume(); await setup.promise;
  assert.equal(setup.job.state, "ready");
  assert.equal(values.get("FREE_LOCAL_GATEWAY_KEY"), credential);
  assert.equal((await setup.overview()).online, true);
});

test("secure connectivity requests never expose Ollama, leak the key, or replace private Serve", async (t) => {
  const commands = [];
  let occupied = false;
  const { setup, values } = fixture(t, {
    runCommandImpl: async (command, args) => {
      commands.push({ command, args });
      if (args[0] === "status") return { ok: true, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "computer.example.ts.net." } }) };
      if (args[0] === "serve") return { ok: true, stdout: JSON.stringify(occupied ? { TCP: { "443": {} }, Web: { private: "127.0.0.1:4317" } } : {}) };
      return { ok: true, stdout: "" };
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://computer.example.ts.net/v1/health");
      assert.equal(options.redirect, "error");
      assert.ok(options.headers.authorization.startsWith("Bearer "));
      return Response.json({ provider: "local" });
    },
  });
  setup.start(); await setup.promise;
  const connection = await setup.connectHosted();
  assert.equal(connection.state, "gateway-ready");
  assert.ok(!JSON.stringify(connection).includes(values.get("FREE_LOCAL_GATEWAY_KEY")));
  assert.ok(commands.some(({ args }) => args[0] === "funnel" && args.at(-1) === `http://127.0.0.1:${setup.gateway.address().port}`));
  assert.ok(!JSON.stringify(commands).includes("11434"));
  occupied = true;
  const before = commands.filter(({ args }) => args[0] === "funnel").length;
  await assert.rejects(setup.connectHosted(), /already has a secure connection/);
  assert.equal(commands.filter(({ args }) => args[0] === "funnel").length, before);
});
