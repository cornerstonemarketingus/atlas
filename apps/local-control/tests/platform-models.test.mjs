import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ModelCapabilityRegistry, CapabilityError, profilesFromRoutes } from "../src/platform/models/capabilities.mjs";
import { CapabilityRouter, NoQualifyingModelError, validateToolCall, toAgentRoutes } from "../src/platform/models/router.mjs";
import { runCapabilitySuite } from "../src/platform/models/capability-suite.mjs";
import { createOllamaAdapter, OllamaError } from "../src/platform/models/ollama-adapter.mjs";

const full = { vision: true, toolCalls: true, structuredOutput: true, contextTokens: 200_000 };

function registry() {
  return new ModelCapabilityRegistry([
    { id: "claude-large", provider: "anthropic", local: false, capabilities: full, costPerMTokIn: 15_000_000, costPerMTokOut: 75_000_000, reliability: 0.97, p50LatencyMs: 4000 },
    { id: "claude-small", provider: "anthropic", local: false, capabilities: full, costPerMTokIn: 1_000_000, costPerMTokOut: 5_000_000, reliability: 0.88, p50LatencyMs: 900 },
    { id: "groq-fast", provider: "groq", local: false, capabilities: { toolCalls: true, structuredOutput: true, contextTokens: 128_000 }, costPerMTokIn: 200_000, costPerMTokOut: 600_000, reliability: 0.8, p50LatencyMs: 300 },
    { id: "ollama-qwen", provider: "ollama", endpoint: "http://127.0.0.1:11434", capabilities: { toolCalls: true, structuredOutput: true, contextTokens: 32_768 }, costPerMTokIn: 0, costPerMTokOut: 0, reliability: 0.7, p50LatencyMs: 2500 },
    { id: "ollama-llama", provider: "ollama", endpoint: "http://127.0.0.1:11434", capabilities: { toolCalls: true, contextTokens: 131_072 }, costPerMTokIn: 0, costPerMTokOut: 0, reliability: 0.75, p50LatencyMs: 3000 },
  ]);
}

test("simple tasks go to the cheapest capable model", () => {
  const router = new CapabilityRouter(registry());
  const decision = router.route({ task: { complexity: "simple", needs: { toolCalls: true } }, constraints: { privacy: "any" } });
  assert.ok(["ollama-qwen", "ollama-llama"].includes(decision.model));
  assert.equal(decision.model, "ollama-llama", "tie on cost broken by reliability");
  assert.match(decision.reason, /cheapest/);
  const vision = router.route({ task: { complexity: "simple", needs: { vision: true } } });
  assert.equal(vision.model, "claude-small");
});

test("complex tasks go to the strongest model by reliability", () => {
  const router = new CapabilityRouter(registry());
  const decision = router.route({ task: { complexity: "complex", needs: { toolCalls: true } }, constraints: { privacy: "any" } });
  assert.equal(decision.model, "claude-large");
  assert.deepEqual(decision.fallbacks, ["claude-small", "groq-fast", "ollama-llama"]);
  assert.match(decision.reason, /most reliable/);
  const moderate = router.route({ task: { complexity: "moderate" } });
  assert.equal(moderate.model, "groq-fast", "cheapest model meeting the 0.8 reliability floor");
});

test("local_only tasks never route to cloud, including fallbacks", () => {
  const router = new CapabilityRouter(registry());
  for (const complexity of ["simple", "moderate", "complex"]) {
    const decision = router.route({ task: { complexity }, constraints: { privacy: "local_only" } });
    const ids = [decision.model, ...decision.fallbacks];
    assert.ok(ids.every((id) => id.startsWith("ollama-")), `${complexity}: ${ids}`);
  }
  assert.throws(() => router.route({ task: { complexity: "simple", needs: { vision: true } }, constraints: { privacy: "local_only" } }), NoQualifyingModelError);
  const preferredIgnored = router.route({ task: { complexity: "complex" }, constraints: { privacy: "local_only", preferredModel: "claude-large" } });
  assert.equal(preferredIgnored.model, "ollama-llama");
  assert.match(preferredIgnored.reason, /not local/);
});

test("registry refuses to call a hosted provider or remote endpoint local", () => {
  const r = new ModelCapabilityRegistry();
  assert.throws(() => r.register({ id: "x", provider: "anthropic", local: true }), CapabilityError);
  assert.throws(() => r.register({ id: "y", provider: "openai-compatible", local: true, endpoint: "https://api.example.com/v1" }), /not loopback/);
  assert.throws(() => r.register({ id: "z", provider: "made-up" }), /unknown provider/);
});

test("budget constraint excludes models over the estimated cost; fallbacks respect it", () => {
  const router = new CapabilityRouter(registry());
  const decision = router.route({
    task: { complexity: "complex", needs: { toolCalls: true }, estimatedTokens: { in: 10_000, out: 2_000 } },
    constraints: { maxCostMicroUsd: 25_000 },
  });
  // claude-large ≈ 300,000 µUSD, claude-small = 20,000, groq ≈ 3,200, local 0
  assert.equal(decision.model, "claude-small");
  assert.ok(decision.estimatedCostMicroUsd <= 25_000);
  assert.ok(!decision.fallbacks.includes("claude-large"));
  assert.throws(() => router.route({ task: { complexity: "simple", needs: { vision: true } }, constraints: { maxCostMicroUsd: 1 } }), /budget/);
});

test("allowedProviders and preferredModel", () => {
  const router = new CapabilityRouter(registry());
  const d = router.route({ task: { complexity: "complex" }, constraints: { allowedProviders: ["groq", "ollama"] } });
  assert.equal(d.model, "groq-fast");
  assert.ok([d.model, ...d.fallbacks].every((id) => !id.startsWith("claude")));
  const p = router.route({ task: { complexity: "simple" }, constraints: { preferredModel: "claude-large" } });
  assert.equal(p.model, "claude-large");
  assert.match(p.reason, /preferred/);
});

test("a clear error when no model qualifies", () => {
  const router = new CapabilityRouter(registry());
  let caught;
  try { router.route({ task: { complexity: "simple", needs: { minContext: 1_000_000 } } }); } catch (error) { caught = error; }
  assert.ok(caught instanceof NoQualifyingModelError);
  assert.equal(caught.code, "NO_QUALIFYING_MODEL");
  assert.match(caught.message, /claude-large \(context 200000 < 1000000/);
  assert.equal(caught.rejected.length, 5);
  assert.throws(() => new CapabilityRouter(new ModelCapabilityRegistry()).route({ task: { complexity: "simple" } }), /no model profiles are registered/);
});

test("measured capabilities override declared ones", () => {
  const r = registry();
  const router = new CapabilityRouter(r);
  assert.equal(router.route({ task: { complexity: "simple", needs: { structuredOutput: true } }, constraints: { privacy: "local_only" } }).model, "ollama-qwen");
  r.recordMeasurement("ollama-qwen", { capabilities: { structuredOutput: false }, reliability: 0.4, measuredAt: "2026-09-01T00:00:00Z" });
  r.recordMeasurement("ollama-llama", { capabilities: { structuredOutput: true }, measuredAt: "2026-09-01T00:00:00Z" });
  const effective = r.effective("ollama-qwen");
  assert.equal(effective.sources.structuredOutput, "measured");
  assert.equal(effective.sources.reliability, "measured");
  assert.equal(effective.sources.toolCalls, "declared");
  assert.equal(router.route({ task: { complexity: "simple", needs: { structuredOutput: true } }, constraints: { privacy: "local_only" } }).model, "ollama-llama");
  // Complex routing among cloud models: measured reliability demotes the large model.
  r.recordMeasurement("claude-large", { reliability: 0.5, measuredAt: "2026-09-01T00:00:00Z" });
  assert.equal(router.route({ task: { complexity: "complex" } }).model, "claude-small");
});

test("validateToolCall accepts well-formed calls and rejects malformed ones", () => {
  const tool = { name: "fs.read", parameters: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", minLength: 1 }, maxBytes: { type: "integer", minimum: 1 } } } };
  assert.deepEqual(validateToolCall('{"name":"fs.read","arguments":{"path":"README.md"}}', tool), { ok: true, call: { name: "fs.read", arguments: { path: "README.md" } } });
  assert.equal(validateToolCall("```json\n{\"name\":\"fs.read\",\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}\n```", tool).ok, true);
  assert.equal(validateToolCall({ function: { name: "fs.read", arguments: '{"path":"a"}' } }, tool).ok, true);
  assert.equal(validateToolCall({ type: "tool_use", id: "toolu_1", name: "fs.read", input: { path: "a" } }, [tool]).call.id, "toolu_1");

  const bad = [
    "not json at all",
    '{"name":"fs.read","arguments":{"path":',
    "[]",
    '{"arguments":{"path":"a"}}',
    '{"name":"fs.delete","arguments":{"path":"a"}}',
    '{"name":"fs.read","arguments":"{broken"}',
    '{"name":"fs.read","arguments":[1,2]}',
    '{"name":"fs.read","arguments":{}}',
    '{"name":"fs.read","arguments":{"path":"a","extra":1}}',
    '{"name":"fs.read","arguments":{"path":"a","maxBytes":"ten"}}',
    '{"name":"fs.read","arguments":{"path":"a","__proto__":{"polluted":true}}}',
  ];
  for (const output of bad) {
    const result = validateToolCall(output, tool);
    assert.equal(result.ok, false, output);
    assert.ok(result.errors.length > 0 && result.errors[0].message, output);
  }
  assert.equal(validateToolCall('{"name":"fs.read","arguments":{"path":"a"}}', []).ok, false);
  assert.equal(validateToolCall("x".repeat(300_000), tool).ok, false);
});

function fakeClient({ json = true, tool = true, recallUpTo = Infinity } = {}) {
  const calls = [];
  return {
    calls,
    async complete({ messages, tools = [], format }) {
      calls.push({ messages, tools, format });
      const prompt = messages.at(-1).content;
      if (tools.length) return tool ? { text: "", toolCalls: [{ name: "lookup_weather", arguments: { city: "Oslo" } }] } : { text: "It is sunny.", toolCalls: [] };
      if (prompt.includes("vault code")) {
        const code = prompt.match(/vault code is (\S+)\./u)[1];
        return { text: prompt.length / 4 <= recallUpTo ? code : "I don't know", toolCalls: [] };
      }
      return { text: json ? '{"city":"Oslo","country":"Norway"}' : "Oslo is in Norway.", toolCalls: [] };
    },
  };
}

test("capability suite records measured capabilities from a fake client", async () => {
  const r = registry();
  const client = fakeClient({ json: false, tool: true, recallUpTo: 2_000 });
  let t = 0;
  const result = await runCapabilitySuite(client, "ollama-qwen", { registry: r, contextSizes: [1_024, 4_096, 16_384], clock: () => (t += 100), now: () => new Date("2026-09-20T00:00:00Z") });
  assert.equal(result.total, 4, "json, tool, recall@1024, recall@4096 (stops at first failure)");
  assert.equal(result.passed, 2);
  const effective = r.effective("ollama-qwen");
  assert.equal(effective.capabilities.structuredOutput, false);
  assert.equal(effective.capabilities.toolCalls, true);
  assert.equal(effective.capabilities.contextTokens, 1_024);
  assert.equal(effective.sources.contextTokens, "measured");
  assert.equal(effective.reliability, 0.5);
  assert.equal(effective.measuredAt, "2026-09-20T00:00:00.000Z");
  assert.notEqual(effective.sources.vision, "measured", "vision is not probed");
  assert.equal(client.calls[0].format, "json");

  const good = await runCapabilitySuite(fakeClient(), "ollama-llama", { registry: r });
  assert.equal(good.passed, good.total);
  assert.equal(r.effective("ollama-llama").capabilities.contextTokens, 131_072, "all sizes passed: declared window kept");
  assert.equal(r.effective("ollama-llama").capabilities.structuredOutput, true);
});

test("capability suite works with a stream()-style client and survives errors", async () => {
  const r = registry();
  const streaming = {
    async *stream({ tools }) {
      if (tools.length) { yield { type: "tool_call", id: "c1", name: "lookup_weather", arguments: '{"city":"oslo"}' }; return; }
      throw new Error("boom");
    },
  };
  const result = await runCapabilitySuite(streaming, "groq-fast", { registry: r, contextSizes: [512] });
  assert.equal(result.probes.find((p) => p.id === "tool-call-format").passed, true);
  assert.match(result.probes.find((p) => p.id === "json-output").detail, /boom/);
  assert.equal(r.effective("groq-fast").capabilities.contextTokens, 0);
});

test("profilesFromRoutes lifts the agent route table and toAgentRoutes maps back", () => {
  const profiles = profilesFromRoutes([
    { task: "coding", model: "qwen2.5-coder:7b", endpoint: "http://127.0.0.1:11434/v1" },
    { task: "vision", model: "qwen2.5-coder:7b", endpoint: "http://127.0.0.1:11434/v1" },
    { task: "planning", model: "big", endpoint: "https://models.example.com/v1", contextWindow: 64_000 },
  ]);
  assert.equal(profiles.length, 2);
  const r = new ModelCapabilityRegistry(profiles);
  const local = r.list().find((p) => p.local);
  assert.equal(local.capabilities.vision, true);
  assert.equal(local.capabilities.contextTokens, 32_768);
  const decision = new CapabilityRouter(r).route({ task: { complexity: "simple" }, constraints: { privacy: "local_only" } });
  const routes = toAgentRoutes(decision, r, "coding");
  assert.deepEqual(routes.map((x) => x.endpoint), ["http://127.0.0.1:11434/v1"]);
});

// ---------------------------------------------------------------------------
// Ollama adapter against an in-test fake server
// ---------------------------------------------------------------------------

async function fakeOllama(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    await handler(req, res, body ? JSON.parse(body) : null);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

test("ollama adapter lists models and chats with tools against a fake server", async () => {
  const server = await fakeOllama((req, res, body) => {
    if (req.url === "/api/tags") return send(res, 200, { models: [{ name: "qwen2.5:7b", size: 4_700_000_000, details: { family: "qwen2", parameter_size: "7.6B", quantization_level: "Q4_K_M" } }, { name: "llava:7b", size: 1 }] });
    if (req.url === "/api/chat") {
      if (body.model === "missing") return send(res, 404, { error: "model 'missing' not found" });
      if (body.tools) return send(res, 200, { model: body.model, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "lookup_weather", arguments: { city: "Oslo" } } }] }, done: true, prompt_eval_count: 12, eval_count: 3, total_duration: 5_000_000 });
      return send(res, 200, { model: body.model, message: { role: "assistant", content: '{"city":"Oslo","country":"Norway"}' }, done: true });
    }
    send(res, 404, { error: "not found" });
  });
  try {
    const ollama = createOllamaAdapter({ baseUrl: server.url, timeoutMs: 2_000 });
    const models = await ollama.listModels();
    assert.deepEqual(models[0], { name: "qwen2.5:7b", sizeBytes: 4_700_000_000, family: "qwen2", parameterSize: "7.6B", quantization: "Q4_K_M" });
    const reply = await ollama.chat({ model: "qwen2.5:7b", messages: [{ role: "user", content: "weather?" }], tools: [{ name: "lookup_weather", parameters: { type: "object" } }] });
    assert.deepEqual(reply.toolCalls, [{ name: "lookup_weather", arguments: { city: "Oslo" } }]);
    assert.deepEqual(reply.usage, { inputTokens: 12, outputTokens: 3 });
    assert.equal(reply.latencyMs, 5);
    const sent = server.requests.find((r) => r.url === "/api/chat");
    assert.equal(sent.body.stream, false);
    assert.equal(sent.body.tools[0].type, "function");
    await assert.rejects(ollama.chat({ model: "missing", messages: [] }), (error) => error instanceof OllamaError && error.code === "MODEL_NOT_FOUND" && /not found/.test(error.message));

    // Profiles + suite end-to-end over HTTP.
    const r = new ModelCapabilityRegistry(await ollama.profiles());
    assert.equal(r.effective("ollama:llava:7b").capabilities.vision, true);
    assert.equal(r.effective("ollama:qwen2.5:7b").local, true);
    const result = await runCapabilitySuite(ollama, "ollama:qwen2.5:7b", { registry: r, contextSizes: [256] });
    assert.equal(result.probes.find((p) => p.id === "json-output").passed, true);
    assert.equal(result.probes.find((p) => p.id === "tool-call-format").passed, true);
    assert.equal(r.effective("ollama:qwen2.5:7b").capabilities.toolCalls, true);
  } finally {
    await server.close();
  }
});

test("ollama adapter times out a slow server and refuses non-loopback URLs", async () => {
  const server = await fakeOllama(async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (!res.writableEnded && !res.destroyed) send(res, 200, { models: [] });
  });
  try {
    const ollama = createOllamaAdapter({ baseUrl: server.url, timeoutMs: 100 });
    const started = Date.now();
    await assert.rejects(ollama.listModels(), (error) => error.code === "TIMEOUT");
    assert.ok(Date.now() - started < 900);
    await assert.rejects(ollama.chat({ model: "m", messages: [], timeout: 50 }), { code: "TIMEOUT" });
  } finally {
    await server.close();
  }
  assert.throws(() => createOllamaAdapter({ baseUrl: "http://10.0.0.5:11434" }), { code: "NOT_LOOPBACK" });
  const unreachable = createOllamaAdapter({ baseUrl: "http://127.0.0.1:1", timeoutMs: 1_000 });
  await assert.rejects(unreachable.listModels(), { code: "UNREACHABLE" });
});
