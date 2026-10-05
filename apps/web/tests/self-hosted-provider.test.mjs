import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatProvider } from "../app/api/chat/providers.mjs";
import { callModel, converse } from "../app/api/chat/agent-loop.mjs";

// The owner's own model (Ollama behind scripts/local/model-gateway.mjs and an
// HTTPS tunnel) as the main model, with Groq and OpenAI as fallbacks so chat
// keeps answering while that machine is off or busy.
const env = {
  ATLAS_CHAT_BASE_URL: "https://models.owner.test/v1", ATLAS_CHAT_MODEL: "qwen3:14b", ATLAS_MODEL_API_KEY: "gateway-token",
  GROQ_API_KEY: "groq-secret", OPENAI_API_KEY: "openai-secret",
};
const turns = [{ role: "user", content: "hello" }];
const ok = (text) => Response.json({ choices: [{ message: { content: text } }] });

test("Automatic routes a self-hosted model, then Groq, then OpenAI; each keeps its own key", () => {
  const route = resolveChatProvider(env);
  assert.equal(route.model, "qwen3:14b");
  assert.equal(route.apiKey, "gateway-token");
  assert.equal(route.timeoutMs, 300_000, "a model on the owner's machine gets longer to answer");
  assert.equal(route.fallbackModel, null, "no invented sibling model on a self-hosted server");
  assert.equal(route.providerFallback.baseUrl, "https://api.groq.com/openai/v1/");
  assert.equal(route.providerFallback.apiKey, "groq-secret");
  assert.equal(route.providerFallback.fallbackModel, "openai/gpt-oss-20b");
  assert.equal(route.providerFallback.timeoutMs, undefined, "hosted providers keep the one-minute limit");
  assert.equal(route.providerFallback.providerFallback.baseUrl, "https://api.openai.com/v1/");
  assert.equal(route.providerFallback.providerFallback.providerFallback, undefined);

  const withoutGroq = resolveChatProvider({ ...env, GROQ_API_KEY: "" });
  assert.equal(withoutGroq.providerFallback.baseUrl, "https://api.openai.com/v1/");
  const groqOnly = resolveChatProvider({ ...env, OPENAI_API_KEY: "" });
  assert.equal(groqOnly.providerFallback.baseUrl, "https://api.groq.com/openai/v1/");
  assert.equal(groqOnly.providerFallback.providerFallback, undefined);
  assert.equal(resolveChatProvider({ ...env, ATLAS_CHAT_FALLBACK_MODEL: "none" }).providerFallback, undefined, "fallbacks can still be turned off");
  assert.equal(resolveChatProvider(env, "configured").providerFallback, undefined);

  // Groq configured as the main model: unchanged, OpenAI is the only cross-provider fallback.
  const groqMain = resolveChatProvider({ ...env, ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "primary", ATLAS_MODEL_API_KEY: "" });
  assert.equal(groqMain.apiKey, "groq-secret");
  assert.equal(groqMain.timeoutMs, undefined);
  assert.equal(groqMain.providerFallback.baseUrl, "https://api.openai.com/v1/");
  assert.equal(groqMain.providerFallback.providerFallback, undefined);
});

for (const [label, down] of [
  ["the tunnel answers 530 (the machine is off)", async () => new Response("error code: 1033", { status: 530 })],
  ["the tunnel's origin times out (524)", async () => new Response("", { status: 524 })],
  ["the connection fails", async () => { throw new TypeError("fetch failed"); }],
  ["the local model is busy (429)", async () => new Response("", { status: 429, headers: { "retry-after": "60" } })],
]) {
  test(`when ${label}, Groq answers`, async () => {
    const calls = [];
    const response = await callModel(resolveChatProvider(env), turns, { stream: false, tools: null, sleep: async () => {}, fetcher: async (url, init) => {
      calls.push({ url, model: JSON.parse(init.body).model, authorization: init.headers.authorization });
      return url.startsWith("https://models.owner.test/") ? down() : ok("from groq");
    } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "from groq");
    assert.deepEqual(calls.map((call) => call.model).slice(-1), ["openai/gpt-oss-120b"]);
    assert.equal(calls.at(-1).authorization, "Bearer groq-secret", "Groq gets Groq's key, never the gateway token");
  });
}

test("with the machine off and Groq out of room, OpenAI answers", async () => {
  const calls = [];
  const response = await callModel(resolveChatProvider(env), turns, { stream: false, tools: null, sleep: async () => {}, fetcher: async (url, init) => {
    calls.push(JSON.parse(init.body).model);
    if (url.startsWith("https://models.owner.test/")) return new Response("", { status: 530 });
    if (url.startsWith("https://api.groq.com/")) return new Response("", { status: 429, headers: { "retry-after": "60" } });
    return ok("from openai");
  } });
  assert.equal((await response.json()).choices[0].message.content, "from openai");
  assert.deepEqual(calls, ["qwen3:14b", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "gpt-5.4-mini"]);
});

test("a wrong gateway token is a configuration error, not something to route around", async () => {
  const calls = [];
  const response = await callModel(resolveChatProvider(env), turns, { stream: false, tools: null, sleep: async () => {}, fetcher: async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ error: { message: "Authentication required" } }), { status: 401 });
  } });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 1);
});

test("an empty final answer walks the whole route: self-hosted, Groq, OpenAI", async () => {
  const read = { choices: [{ message: { tool_calls: [{ id: "read1", type: "function", function: { name: "read_web_page", arguments: JSON.stringify({ url: "https://example.com" }) } }] } }] };
  const empty = () => Response.json({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  const models = [];
  const replies = [() => Response.json(read), empty, empty, empty, empty, () => ok("Written by OpenAI.")];
  const fetcher = async (url, init) => {
    if (!/owner\.test|groq\.com|openai\.com/u.test(String(url))) return new Response("<title>Example</title><p>Example body</p>", { headers: { "content-type": "text/html" } });
    models.push(JSON.parse(init.body).model);
    return replies.shift()();
  };
  const outcome = await converse({
    endpoint: resolveChatProvider(env), turns: [{ role: "system", content: "sys" }, ...turns],
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined, fetcher },
    defaultRepository: "cornerstonemarketingus/atlas", userMessage: "hello", startTasks: async () => [], stream: false, emit: () => {}, fetcher, sleep: async () => {},
  });
  assert.equal(outcome.reply, "Written by OpenAI.");
  // Tool round and the empty turn on the local model, its second synthesis try, then Groq, then OpenAI.
  assert.deepEqual(models, ["qwen3:14b", "qwen3:14b", "qwen3:14b", "qwen3:14b", "openai/gpt-oss-120b", "gpt-5.4-mini"]);
});
