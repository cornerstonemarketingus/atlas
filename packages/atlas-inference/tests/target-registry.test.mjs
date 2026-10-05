import assert from "node:assert/strict";
import test from "node:test";
import { createTargetRegistry, listModels, validateBaseUrl } from "../src/index.mjs";

// Groq's /models shape (ids as served today; a retired one is simply absent).
const groqModels = { object: "list", data: [
  { id: "openai/gpt-oss-120b", object: "model", owned_by: "OpenAI", active: true, context_window: 131072 },
  { id: "openai/gpt-oss-20b", object: "model", owned_by: "OpenAI", active: true, context_window: 131072 },
  { id: "old/model", object: "model", owned_by: "x", active: false, context_window: 8192 },
] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("base URLs: HTTPS for remote hosts, HTTP only on loopback, no credentials or query", () => {
  assert.equal(validateBaseUrl("https://api.groq.com/openai/v1").href, "https://api.groq.com/openai/v1/");
  assert.equal(validateBaseUrl("http://127.0.0.1:11434/v1").hostname, "127.0.0.1");
  assert.throws(() => validateBaseUrl("http://example.com/v1"), /HTTPS/u);
  assert.throws(() => validateBaseUrl("https://user:pass@example.com/v1"), /credentials/u);
  assert.throws(() => validateBaseUrl("https://example.com/v1?key=x"), /query/u);
  assert.throws(() => validateBaseUrl("not a url"), /valid URL/u);
});

test("listModels reads Groq's list, with context windows, and sends the key only as a header", async () => {
  let seen;
  const result = await listModels({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", fetcher: async (url, init) => { seen = { url: String(url), auth: init.headers.authorization }; return json(groqModels); } });
  assert.equal(seen.url, "https://api.groq.com/openai/v1/models");
  assert.equal(seen.auth, "Bearer k");
  assert.deepEqual(result.models[0], { id: "openai/gpt-oss-120b", contextWindowTokens: 131072, ownedBy: "OpenAI", active: true });
  assert.equal(result.models[2].active, false);
});

test("listModels never throws: refusals and outages come back classified", async () => {
  assert.deepEqual(await listModels({ baseUrl: "https://x.test/v1", fetcher: async () => json({}, 401) }), { ok: false, kind: "AUTHENTICATION", status: 401 });
  assert.equal((await listModels({ baseUrl: "https://x.test/v1", fetcher: async () => { throw new TypeError("offline"); } })).kind, "NETWORK");
  assert.equal((await listModels({ baseUrl: "https://x.test/v1", fetcher: async () => new Response("<html>", { status: 200 }) })).kind, "INVALID_RESPONSE");
  // vLLM and Ollama shapes.
  assert.equal((await listModels({ baseUrl: "http://localhost:8000/v1", fetcher: async () => json({ data: [{ id: "qwen", max_model_len: 32768 }] }) })).models[0].contextWindowTokens, 32768);
  assert.equal((await listModels({ baseUrl: "http://localhost:11434/v1", fetcher: async () => json({ models: [{ name: "llama3" }] }) })).models[0].id, "llama3");
});

test("the registry marks a retired or inactive model unavailable before any request fails on it", async () => {
  const registry = createTargetRegistry({
    fetcher: async () => json(groqModels),
    endpoints: [{ id: "groq", provider: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", models: [{ model: "openai/gpt-oss-120b" }, { model: "llama3-70b-8192" }, { model: "old/model" }, { model: "openai/gpt-oss-20b" }] }],
  });
  const targets = await registry.targets();
  assert.deepEqual(targets.map((target) => [target.model, target.available, target.reason ?? null]), [
    ["openai/gpt-oss-120b", true, null], ["llama3-70b-8192", false, "not_served"], ["old/model", false, "inactive"], ["openai/gpt-oss-20b", true, null],
  ]);
  assert.equal(targets[0].contextWindowTokens, 131072, "taken from the server when not configured");
  assert.deepEqual((await registry.eligibleTargets()).map((target) => target.model), ["openai/gpt-oss-120b", "openai/gpt-oss-20b"], "configured order is kept");
});

test("a server that does not list models keeps its targets eligible (unknown is not unavailable)", async () => {
  const registry = createTargetRegistry({
    fetcher: async () => new Response("not found", { status: 404 }),
    endpoints: [{ id: "home", baseUrl: "http://127.0.0.1:8080/v1", local: true, models: [{ model: "local-coder", contextWindowTokens: 32768 }] }],
  });
  const [target] = await registry.targets();
  assert.equal(target.available, null);
  assert.equal(target.local, true);
  assert.equal((await registry.eligibleTargets()).length, 1);
});

test("probes are cached for their TTL and refreshed after", async () => {
  let calls = 0;
  let now = 0;
  const registry = createTargetRegistry({ now: () => now, ttlMs: 1_000, fetcher: async () => { calls += 1; return json(groqModels); }, endpoints: [{ id: "groq", baseUrl: "https://api.groq.com/openai/v1", models: [{ model: "openai/gpt-oss-20b" }] }] });
  await registry.targets();
  await registry.targets();
  assert.equal(calls, 1);
  now = 1_000;
  await registry.targets();
  assert.equal(calls, 2);
});
