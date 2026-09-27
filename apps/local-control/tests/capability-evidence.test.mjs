import test from "node:test";
import assert from "node:assert/strict";
import { ModelCapabilityRegistry } from "../src/platform/models/capabilities.mjs";
import { runCapabilitySuite } from "../src/platform/models/capability-suite.mjs";

const at = "2026-09-26T00:00:00.000Z";
const profile = { id: "local", provider: "ollama", model: "fixture", endpoint: "http://localhost:11434", capabilities: { contextTokens: 131072, vision: true }, reliability: 0.8 };
function harness() {
  const registry = new ModelCapabilityRegistry([profile]);
  let calls = 0;
  const client = { async complete({ messages, tools }) {
    calls++;
    if (tools?.length) return { toolCalls: [{ name: "lookup_weather", arguments: { city: "Oslo" } }] };
    const code = messages[0].content.match(/vault code is (\S+)\./u)?.[1];
    return { text: code ?? '{"city":"Oslo","country":"Norway"}' };
  } };
  return { registry, client, calls: () => calls };
}

test("invalid probe configurations fail before inference or mutation", async () => {
  for (const options of [{ trials: 0 }, { trials: -1 }, { trials: 1.5 }, { trials: Infinity }, { trials: 101 }, { contextSizes: [0] }, { contextSizes: [-1] }, { contextSizes: [NaN] }, { contextSizes: [2 ** 30] }, { contextSizes: "1024" }]) {
    const h = harness();
    await assert.rejects(runCapabilitySuite(h.client, "local", { registry: h.registry, ...options }), /trials|contextSizes/);
    assert.equal(h.calls(), 0);
    assert.equal(h.registry.get("local").measured, null);
  }
});

test("successful short recall does not label an advertised window measured", async () => {
  const h = harness();
  const result = await runCapabilitySuite(h.client, "local", { registry: h.registry, contextSizes: [1024], now: () => new Date(at) });
  assert.equal(result.effective.capabilities.contextTokens, 131072);
  assert.equal(result.effective.sources.contextTokens, "declared");
  assert.equal(result.effective.contextVerifiedTokens, 1024);
  assert.equal(result.effective.structuredOutputReliability, 1);
  assert.equal(result.effective.toolCallReliability, 1);
});

test("snapshot restore retains declared values and probe evidence without aliases", async () => {
  const h = harness();
  const result = await runCapabilitySuite(h.client, "local", { registry: h.registry, contextSizes: [512], now: () => new Date(at) });
  const snapshot = h.registry.snapshot();
  const restored = new ModelCapabilityRegistry(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.deepEqual(restored.effective("local"), h.registry.effective("local"));
  result.measured.probes.results[0].passed = false;
  snapshot[0].measured.probes.results[0].passed = false;
  assert.equal(h.registry.get("local").measured.probes.results[0].passed, true);
  assert.equal(restored.get("local").measured.probes.results[0].passed, true);
});

test("measurements survive metadata refresh but not a changed model identity", () => {
  const registry = new ModelCapabilityRegistry([profile]);
  registry.recordMeasurement("local", { capabilities: { toolCalls: true }, measuredAt: at });
  registry.upsert({ ...profile, reliability: 0.9 });
  assert.equal(registry.effective("local").sources.toolCalls, "measured");
  registry.upsert({ ...profile, model: "different-model" });
  assert.equal(registry.effective("local").sources.toolCalls, "unknown");
});

test("probe health distinguishes unavailable inference from incorrect answers", async () => {
  const registry = new ModelCapabilityRegistry([profile]);
  await runCapabilitySuite({ async complete() { throw new Error("offline"); } }, "local", { registry, contextSizes: [], now: () => new Date(at) });
  assert.equal(registry.effective("local").health.status, "unavailable");
  assert.equal(registry.effective("local").recentFailureRate, 1);
  await runCapabilitySuite({ async complete() { return { text: "incorrect" }; } }, "local", { registry, contextSizes: [], now: () => new Date(at) });
  assert.equal(registry.effective("local").health.status, "available");
  assert.equal(registry.effective("local").structuredOutputReliability, 0);
  assert.equal(registry.effective("local").recentFailureRate, 1);
});

test("untested context remains unknown and repeated sizes are probed once", async () => {
  const h = harness();
  await runCapabilitySuite(h.client, "local", { registry: h.registry, contextSizes: [] });
  assert.equal(h.registry.effective("local").contextVerifiedTokens, null);
  const result = await runCapabilitySuite(h.client, "local", { registry: h.registry, contextSizes: [512, 512] });
  assert.equal(result.total, 3);
});

test("a model override cannot attach another model's results to this profile", async () => {
  const h = harness();
  await assert.rejects(runCapabilitySuite(h.client, "local", { registry: h.registry, model: "other" }), /model must match/);
  assert.equal(h.calls(), 0);
  assert.equal(h.registry.get("local").measured, null);
});

test("mixed probe outcomes retain category rates and invalid measurements are atomic", async () => {
  const h = harness();
  let calls = 0;
  const client = { async complete(request) {
    if (++calls === 1) throw new Error("temporarily unavailable");
    return h.client.complete(request);
  } };
  await runCapabilitySuite(client, "local", { registry: h.registry, trials: 2, contextSizes: [], now: () => new Date(at) });
  const result = h.registry.effective("local");
  assert.equal(result.structuredOutputReliability, 0.5);
  assert.equal(result.toolCallReliability, 1);
  assert.equal(result.recentFailureRate, 0.25);
  assert.deepEqual(result.health, { status: "degraded", checkedAt: at });
  result.health.status = "available";
  const before = h.registry.snapshot();
  for (const invalid of [{ structuredOutputReliability: 2 }, { health: { status: "available", checkedAt: "bad" } }, { probes: { results: [{}] } }]) {
    assert.throws(() => h.registry.recordMeasurement("local", { measuredAt: at, ...invalid }));
    assert.deepEqual(h.registry.snapshot(), before);
  }
  assert.equal(h.registry.effective("local").health.status, "degraded");
});
