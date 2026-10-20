import assert from "node:assert/strict";
import test from "node:test";
import { chatProviderChoices, chatRoute, freeTierModel, resolveChatProvider } from "../app/api/chat/providers.mjs";
import { callModel, incompatibility } from "../app/api/chat/agent-loop.mjs";
import { providerKind, resolveChatModel } from "../app/api/chat/model-endpoint.mjs";

// The free-tier pool: every hosted free allowance the owner adds a key for
// joins chat's Automatic route, so one exhausted daily quota is not the end
// of chat. Keys go only to their own provider's fixed origin.
const account = "0123456789abcdef0123456789abcdef";
const pool = { CEREBRAS_API_KEY: "cerebras-secret", NVIDIA_API_KEY: "nvidia-secret", GEMINI_API_KEY: "gemini-secret", OPENROUTER_API_KEY: "openrouter-secret" };
const everything = { ...pool, ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "groq-secret", CLOUDFLARE_ACCOUNT_ID: account, ATLAS_WORKERS_AI_TOKEN: "cf-secret", OPENAI_API_KEY: "openai-secret" };
const ORIGIN_KEYS = new Map([
  ["https://api.groq.com", "groq-secret"], ["https://api.cloudflare.com", "cf-secret"], ["https://api.cerebras.ai", "cerebras-secret"],
  ["https://integrate.api.nvidia.com", "nvidia-secret"], ["https://generativelanguage.googleapis.com", "gemini-secret"],
  ["https://openrouter.ai", "openrouter-secret"], ["https://api.openai.com", "openai-secret"],
]);
const turns = [{ role: "user", content: "hello" }];
const ok = (text) => Response.json({ choices: [{ message: { content: text } }] });
const dailyQuota = () => new Response(JSON.stringify({ error: { message: "daily quota exhausted" } }), { status: 429, headers: { "retry-after": "40000" } });
const noCredits = () => new Response(JSON.stringify({ error: { message: "insufficient credits" } }), { status: 402 });

test("each pool provider is configured by its key alone, at its fixed origin, with no key no provider", () => {
  assert.deepEqual(
    ["cerebras", "nvidia", "gemini", "openrouter"].map((id) => [id, freeTierModel(id, pool).baseUrl, freeTierModel(id, pool).model]),
    [
      ["cerebras", "https://api.cerebras.ai/v1/", "gpt-oss-120b"],
      ["nvidia", "https://integrate.api.nvidia.com/v1/", "openai/gpt-oss-120b"],
      ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-flash-latest"],
      ["openrouter", "https://openrouter.ai/api/v1/", "openai/gpt-oss-120b:free"],
    ],
  );
  assert.equal(freeTierModel("gemini", pool).fallbackModel, "gemini-flash-lite-latest", "Gemini limits each model separately");
  assert.equal(freeTierModel("cerebras", { CEREBRAS_API_KEY: "  " }), null);
  assert.equal(freeTierModel("unknown", pool), null);
  for (const id of ["cerebras", "nvidia", "gemini", "openrouter"]) {
    assert.equal(freeTierModel(id, pool).timeoutMs, undefined, "hosted providers keep the one-minute limit");
    assert.equal(providerKind(freeTierModel(id, pool).baseUrl), id);
  }
});

test("Automatic walks main → Workers AI → Groq → the pool → paid OpenAI last, never repeating an origin", () => {
  assert.deepEqual(chatRoute(everything), ["groq", "workers-ai", "cerebras", "nvidia", "gemini", "openrouter", "openai"]);
  assert.deepEqual(chatRoute(pool), ["cerebras", "nvidia", "gemini", "openrouter"], "the pool alone runs chat");
  assert.deepEqual(chatRoute({ OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "o" }), ["openrouter", "openai"]);
  const ownModel = { ...everything, ATLAS_CHAT_BASE_URL: "https://models.owner.test/v1", ATLAS_CHAT_MODEL: "qwen3:14b", ATLAS_MODEL_API_KEY: "gateway-token" };
  assert.deepEqual(chatRoute(ownModel), ["self-hosted", "workers-ai", "groq", "cerebras", "nvidia", "gemini", "openrouter", "openai"]);
  assert.deepEqual(chatRoute({ ...ownModel, ATLAS_CHAT_FALLBACK_MODEL: "none" }), ["self-hosted"], "\"none\" still means no fallback route");
  const cerebrasMain = { ...pool, ATLAS_CHAT_BASE_URL: "https://api.cerebras.ai/v1", ATLAS_CHAT_MODEL: "gpt-oss-120b" };
  assert.deepEqual(chatRoute(cerebrasMain), ["cerebras", "nvidia", "gemini", "openrouter"], "a pool provider as main model is not repeated");
});

test("pointing ATLAS_CHAT_BASE_URL at a pool provider uses that provider's own key and the hosted timeout", () => {
  const resolved = resolveChatModel({ ATLAS_CHAT_BASE_URL: "https://openrouter.ai/api/v1", ATLAS_CHAT_MODEL: "qwen/qwen3-coder:free", OPENROUTER_API_KEY: "openrouter-secret", CEREBRAS_API_KEY: "cerebras-secret" });
  assert.equal(resolved.apiKey, "openrouter-secret");
  assert.equal(resolved.timeoutMs, undefined);
  const unknownHost = resolveChatModel({ ATLAS_CHAT_BASE_URL: "https://models.owner.test/v1", ATLAS_CHAT_MODEL: "m", OPENROUTER_API_KEY: "openrouter-secret" });
  assert.equal(unknownHost.apiKey, null, "a pool key never reaches an owner-configured host");
  assert.equal(resolveChatModel({ ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "m", GROQ_API_KEY: "groq-secret" }).apiKey, "groq-secret", "Groq's existing key reuse is unchanged");
});

test("ATLAS_PROVIDER_MODELS overrides a pool model; junk and unknown providers are ignored", () => {
  const env = { ...pool, ATLAS_PROVIDER_MODELS: "openrouter=qwen/qwen3-coder:free, cerebras=bad model, nope=x, gemini=gemini-flash-lite-latest, nvidia=a=b" };
  assert.equal(freeTierModel("openrouter", env).model, "qwen/qwen3-coder:free");
  assert.equal(freeTierModel("cerebras", env).model, "gpt-oss-120b", "a name with a space is not a model name");
  assert.equal(freeTierModel("nvidia", env).model, "openai/gpt-oss-120b");
  assert.equal(freeTierModel("gemini", env).fallbackModel, null, "no sibling of itself");
  assert.equal(freeTierModel("cerebras", { ...pool, ATLAS_PROVIDER_MODELS: "cerebras=qwen-3-coder-480b" }).capabilities.contextTokens, undefined, "another model's window is not assumed");
});

test("every free daily quota spent: the request walks the whole pool and the last free provider answers", async () => {
  const calls = [];
  const response = await callModel(resolveChatProvider(everything), turns, { stream: false, tools: null, sleep: async () => {}, fetcher: async (url, init) => {
    const origin = new URL(url).origin;
    calls.push({ origin, authorization: init.headers.authorization, model: JSON.parse(init.body).model });
    return origin === "https://openrouter.ai" ? ok("from openrouter") : dailyQuota();
  } });
  assert.equal((await response.json()).choices[0].message.content, "from openrouter");
  const visited = [...new Set(calls.map((call) => call.origin))];
  assert.deepEqual(visited, ["https://api.groq.com", "https://api.cloudflare.com", "https://api.cerebras.ai", "https://integrate.api.nvidia.com", "https://generativelanguage.googleapis.com", "https://openrouter.ai"]);
  assert.ok(calls.some((call) => call.model === "gemini-flash-lite-latest"), "Gemini's sibling model is tried before leaving Gemini");
  assert.ok(!visited.includes("https://api.openai.com"), "paid OpenAI is not reached while a free provider answers");
  for (const call of calls) assert.equal(call.authorization, `Bearer ${ORIGIN_KEYS.get(call.origin)}`, `${call.origin} received only its own key`);
});

test("an account without credits (402) moves on; a rejected key (401) is shown, not routed around", async () => {
  const env = { CEREBRAS_API_KEY: "cerebras-secret", OPENROUTER_API_KEY: "openrouter-secret" };
  const routed = await callModel(resolveChatProvider(env), turns, { stream: false, tools: null, sleep: async () => {}, fetcher: async (url) => (url.startsWith("https://api.cerebras.ai/") ? noCredits() : ok("next")) });
  assert.equal(routed.status, 200);
  const origins = [];
  const rejected = await callModel(resolveChatProvider(env), turns, { stream: false, tools: null, sleep: async () => {}, fetcher: async (url) => {
    origins.push(new URL(url).origin);
    return new Response("{}", { status: 401 });
  } });
  assert.equal(rejected.status, 401);
  assert.deepEqual(origins, ["https://api.cerebras.ai"]);
});

test("Cerebras' free window is respected: an oversized request skips it instead of being sent", () => {
  const cerebras = freeTierModel("cerebras", pool);
  const huge = [{ role: "user", content: "x".repeat(300_000) }];
  assert.equal(incompatibility(cerebras, huge, { tools: null, stream: false }), "context");
  assert.equal(incompatibility(cerebras, turns, { tools: null, stream: false }), null);
});

test("a pool provider can be chosen in the Model menu; the rest of the route stays as recovery", () => {
  const choices = chatProviderChoices(everything);
  for (const id of ["cerebras", "nvidia", "gemini", "openrouter"]) assert.equal(choices.find((choice) => choice.id === id)?.available, true);
  assert.equal(chatProviderChoices({}).some((choice) => choice.id === "cerebras"), false, "unconfigured pool providers are not listed");
  assert.doesNotMatch(JSON.stringify(choices), /secret|https:/u);
  const chosen = resolveChatProvider(everything, "gemini");
  assert.equal(chosen.provider, "gemini");
  const route = [];
  for (let provider = chosen; provider; provider = provider.providerFallback) route.push(providerKind(provider.baseUrl));
  assert.deepEqual(route, ["gemini", "groq", "workers-ai", "cerebras", "nvidia", "openrouter", "openai"]);
  assert.equal(resolveChatProvider({}, "gemini").configured, false);
  assert.equal(resolveChatProvider({ ...everything, ATLAS_CHAT_FALLBACK_MODEL: "none" }, "nvidia").providerFallback, undefined);
});
