import assert from "node:assert/strict";
import test from "node:test";
import { chatProviderChoices, resolveChatProvider } from "../app/api/chat/providers.mjs";
import { callModel, converse } from "../app/api/chat/agent-loop.mjs";

const env = { ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "primary", ATLAS_MODEL_API_KEY: "groq-secret", OPENAI_API_KEY: "openai-secret" };
const turns = [{ role: "user", content: "hello" }];
test("selection and fallback are server-owned, optional, and never expose credentials", () => {
  const automatic = resolveChatProvider(env);
  assert.equal(automatic.apiKey, "groq-secret");
  assert.equal(automatic.providerFallback.apiKey, "openai-secret");
  assert.equal(automatic.providerFallback.baseUrl, "https://api.openai.com/v1/");
  assert.equal(resolveChatProvider(env, "configured").providerFallback, undefined);
  assert.equal(resolveChatProvider({ ...env, ATLAS_CHAT_FALLBACK_MODEL: "none" }).providerFallback, undefined);
  assert.equal(resolveChatProvider(env, "https://evil.test").configured, false);
  assert.equal(resolveChatProvider({}, "openai").configured, false);
  assert.equal(resolveChatProvider({ OPENAI_API_KEY: "key" }).provider, "openai");
  assert.equal(resolveChatProvider({ ...env, ATLAS_CHAT_BASE_URL: "http://remote.test" }).configured, false);
  assert.equal(resolveChatProvider({ ...env, ATLAS_CHAT_BASE_URL: "https://custom.test/v1", ATLAS_MODEL_API_KEY: "" }, "configured").apiKey, null);
  assert.equal(resolveChatProvider({ ...env, ATLAS_CHAT_BASE_URL: "https://api.openai.com/v1", ATLAS_MODEL_API_KEY: "" }, "configured").apiKey, "openai-secret");
  const choices = JSON.stringify(chatProviderChoices(env));
  assert.doesNotMatch(choices, /secret|apiKey|baseUrl/u);
});

test("both Groq models can rate-limit and OpenAI continues the same context with its own key", async () => {
  const calls = [];
  const response = await callModel(resolveChatProvider(env), turns, { stream: false, tools: null, sleep: async () => {}, fetcher: async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization, body: JSON.parse(init.body) });
    return url.startsWith("https://api.openai.com/") ? Response.json({ choices: [{ message: { content: "Recovered" } }] }) : new Response("", { status: 429, headers: { "retry-after": "60" } });
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((c) => c.body.model), ["primary", "openai/gpt-oss-20b", "gpt-5.4-mini"]);
  assert.deepEqual(calls.map((c) => c.authorization), ["Bearer groq-secret", "Bearer groq-secret", "Bearer openai-secret"]);
  assert.deepEqual(calls[2].body.messages, turns);
  assert.equal(calls[2].body.max_completion_tokens, 2048);
  assert.equal(calls[2].body.max_tokens, undefined);
  assert.equal(calls[2].body.temperature, undefined);
  assert.equal(calls[2].body.reasoning_effort, "none");
});

test("temporary errors recover but authentication failures do not silently switch providers", async () => {
  for (const status of [401, 403, 400, 503]) {
    const urls = [];
    await callModel(resolveChatProvider(env), turns, { stream: false, fetcher: async (url) => { urls.push(url); return new Response("", { status: urls.length === 1 ? status : 200 }); } });
    assert.equal(urls.length, status === 503 ? 2 : 1);
  }
  let attempts = 0;
  const recovered = await callModel(resolveChatProvider(env), turns, { stream: false, fetcher: async () => { if (++attempts === 1) throw new TypeError("offline"); return new Response("ok"); } });
  assert.equal(recovered.status, 200);
  assert.equal(attempts, 2);
});

test("OpenAI selection completes a streaming chat turn", async () => {
  const emitted = [];
  const outcome = await converse({ endpoint: resolveChatProvider(env, "openai"), turns,
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined },
    userMessage: "hello", stream: true, emit: (type, data) => emitted.push({ type, data }),
    fetcher: async () => new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }),
    startTasks: async () => [],
  });
  assert.equal(outcome.reply, "Hello");
  assert.ok(emitted.some((event) => event.type === "delta"));
});

test("selected OpenAI recovers through configured models with the same context and isolated credentials", async () => {
  const calls = [];
  const context = [...turns, { role: "assistant", content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: "read_file", arguments: "{}" } }] }, { role: "tool", tool_call_id: "read-1", content: "Saved repository evidence" }];
  const response = await callModel(resolveChatProvider(env, "openai"), context, { stream: false, sleep: async () => {}, fetcher: async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, key: init.headers.authorization });
    return body.model === "openai/gpt-oss-20b" ? Response.json({ choices: [{ message: { content: "Continued" } }] }) : new Response("", { status: 429, headers: { "retry-after": "60" } });
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(c => c.body.model), ["gpt-5.4-mini", "primary", "openai/gpt-oss-20b"]);
  assert.deepEqual(calls.map(c => c.key), ["Bearer openai-secret", "Bearer groq-secret", "Bearer groq-secret"]);
  assert.ok(calls.every(c => JSON.stringify(c.body.messages) === JSON.stringify(context)));
  assert.ok(calls.slice(1).every(c => c.url.startsWith("https://api.groq.com/") && c.body.max_tokens === 2048 && c.body.max_completion_tokens === undefined));
});

test("selected provider recovery respects opt-out, endpoint validation and authentication failures", async () => {
  for (const overrides of [{ ATLAS_CHAT_FALLBACK_MODEL: "none" }, { ATLAS_CHAT_BASE_URL: "http://remote.test/v1" }, { ATLAS_CHAT_BASE_URL: "https://user:password@remote.test/v1" }, { ATLAS_CHAT_BASE_URL: "https://api.openai.com/v1" }]) {
    assert.equal(resolveChatProvider({ ...env, ...overrides }, "openai").providerFallback, undefined);
  }
  for (const status of [401, 403, 400]) {
    let calls = 0;
    const response = await callModel(resolveChatProvider(env, "openai"), turns, { stream: false, fetcher: async () => { calls++; return new Response("", { status }); } });
    assert.equal(response.status, status);
    assert.equal(calls, 1);
  }
});

test("selected OpenAI 429 recovers to a streamed answer through the production conversation loop", async () => {
  const emitted = [];
  const calls = [];
  const outcome = await converse({ endpoint: resolveChatProvider(env, "openai"), turns,
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined },
    userMessage: "Continue the saved work", stream: true, emit: (type, data) => emitted.push({ type, data }),
    fetcher: async (url) => { calls.push(url); return url.startsWith("https://api.openai.com/")
      ? new Response("", { status: 429, headers: { "retry-after": "3600" } })
      : new Response('data: {"choices":[{"delta":{"content":"Continued the work"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }); },
    startTasks: async () => [],
  });
  assert.equal(outcome.reply, "Continued the work");
  assert.equal(outcome.error, undefined);
  assert.equal(calls.length, 2);
  assert.ok(emitted.some(e => e.type === "delta"));
});
