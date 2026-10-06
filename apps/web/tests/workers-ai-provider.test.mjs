import assert from "node:assert/strict";
import test from "node:test";
import { chatProviderChoices, chatRoute, resolveChatProvider, workersAIModel } from "../app/api/chat/providers.mjs";
import { callModel, converse } from "../app/api/chat/agent-loop.mjs";

// Cloudflare Workers AI on the account that already runs Atlas: chat without
// Groq, without a model on the owner's machine, and without OpenAI credits.
const account = "0123456789abcdef0123456789abcdef";
const workersOnly = { CLOUDFLARE_ACCOUNT_ID: account, ATLAS_WORKERS_AI_TOKEN: "cf-workers-ai-token" };
const turns = [{ role: "user", content: "hello" }];
const ok = (text) => Response.json({ choices: [{ message: { content: text } }] });

test("Workers AI is configured by its token and a valid account id, at the fixed Cloudflare origin", () => {
  const workers = workersAIModel(workersOnly);
  assert.equal(workers.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/`);
  assert.equal(workers.model, "@cf/openai/gpt-oss-120b");
  assert.equal(workers.fallbackModel, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(workers.timeoutMs, undefined, "a hosted provider keeps the one-minute limit");
  assert.equal(workersAIModel({ ...workersOnly, ATLAS_WORKERS_AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }).fallbackModel, null, "no sibling of itself");
  assert.equal(workersAIModel({ ...workersOnly, ATLAS_WORKERS_AI_TOKEN: "" }), null);
  assert.equal(workersAIModel({ ...workersOnly, CLOUDFLARE_ACCOUNT_ID: "../../evil" }), null, "the account id cannot steer the URL");
  assert.equal(workersAIModel({ ...workersOnly, CLOUDFLARE_ACCOUNT_ID: account.toUpperCase() }).baseUrl.includes(account), true);
});

test("with nothing else configured, Workers AI alone runs chat; it joins every route after the main model", () => {
  assert.deepEqual(chatRoute(workersOnly), ["workers-ai"]);
  assert.equal(resolveChatProvider(workersOnly).provider, "workers-ai");
  const groqMain = { ...workersOnly, ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "big", GROQ_API_KEY: "groq-secret", OPENAI_API_KEY: "openai-secret" };
  assert.deepEqual(chatRoute(groqMain), ["groq", "workers-ai", "openai"], "Groq is not repeated");
  const ownModel = { ...groqMain, ATLAS_CHAT_BASE_URL: "https://models.owner.test/v1", ATLAS_CHAT_MODEL: "qwen3:14b", ATLAS_MODEL_API_KEY: "gateway-token" };
  assert.deepEqual(chatRoute(ownModel), ["self-hosted", "workers-ai", "groq", "openai"]);
  assert.deepEqual(chatRoute({ ...ownModel, ATLAS_CHAT_FALLBACK_MODEL: "none" }), ["self-hosted"]);
  assert.equal(resolveChatProvider({ ...workersOnly, ATLAS_CHAT_BASE_URL: "http://remote.test" }).configured, false, "an invalid explicit endpoint is still an error");

  const chosen = resolveChatProvider(groqMain, "workers-ai");
  assert.equal(chosen.provider, "workers-ai");
  assert.equal(chosen.providerFallback.baseUrl, "https://api.groq.com/openai/v1/");
  assert.equal(chosen.providerFallback.providerFallback.baseUrl, "https://api.openai.com/v1/");
  assert.equal(resolveChatProvider({}, "workers-ai").configured, false);
  const choices = chatProviderChoices(groqMain);
  assert.deepEqual(choices.find((choice) => choice.id === "workers-ai"), { id: "workers-ai", label: "Cloudflare Workers AI", available: true });
  assert.doesNotMatch(JSON.stringify(choices), /token|secret|cloudflare\.com/u);
});

test("Groq refusing a request as too large moves to Workers AI with its own token, in plain OpenAI-compatible form", async () => {
  const env = { ...workersOnly, ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "big", GROQ_API_KEY: "groq-secret", ATLAS_CHAT_FALLBACK_MODEL: "" };
  const calls = [];
  const tooLarge = () => new Response(JSON.stringify({ error: { message: "Request too large for model on tokens per minute (TPM): Limit 8000, Requested 9500" } }), { status: 429 });
  const response = await callModel(resolveChatProvider(env), turns, { stream: false, tools: null, sleep: async () => {}, fetcher: async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization, body: JSON.parse(init.body) });
    return url.startsWith("https://api.cloudflare.com/") ? ok("from workers ai") : tooLarge();
  } });
  assert.equal((await response.json()).choices[0].message.content, "from workers ai");
  const sent = calls.at(-1);
  assert.equal(sent.url, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`);
  assert.equal(sent.authorization, "Bearer cf-workers-ai-token");
  assert.equal(sent.body.model, "@cf/openai/gpt-oss-120b");
  assert.equal(typeof sent.body.max_tokens, "number");
  assert.equal(sent.body.max_completion_tokens, undefined);
  for (const call of calls.filter((entry) => !entry.url.startsWith("https://api.cloudflare.com/"))) assert.notEqual(call.authorization, "Bearer cf-workers-ai-token", "the Workers AI token goes nowhere else");
});

test("a reply written by Workers AI says so", async () => {
  const fetcher = async () => ok("Hello from Cloudflare.");
  const outcome = await converse({
    endpoint: resolveChatProvider(workersOnly), turns: [{ role: "system", content: "sys" }, ...turns],
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined, fetcher },
    defaultRepository: "cornerstonemarketingus/atlas", userMessage: "hello", startTasks: async () => [], stream: false, emit: () => {}, fetcher, sleep: async () => {},
  });
  assert.equal(outcome.reply, "Hello from Cloudflare.");
  assert.deepEqual(outcome.servedBy, { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" });
});

// Production (2026-10-06): with Workers AI configured, hosted chat answered only
// "The model endpoint answered 401." — no way to tell which provider refused.
test("a rejected credential names the provider that rejected it, so the owner knows which key to fix", async () => {
  const env = { ...workersOnly, ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "big", GROQ_API_KEY: "groq-secret", ATLAS_CHAT_FALLBACK_MODEL: "" };
  const tooLarge = () => new Response(JSON.stringify({ error: { message: "Request too large for model on tokens per minute (TPM): Limit 8000, Requested 9500" } }), { status: 429 });
  const fetcher = async (url) => (String(url).startsWith("https://api.cloudflare.com/") ? new Response(JSON.stringify({ errors: [{ message: "private provider text" }] }), { status: 401 }) : tooLarge());
  const failed = await converse({
    endpoint: resolveChatProvider(env), turns: [{ role: "system", content: "sys" }, ...turns],
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined, fetcher },
    defaultRepository: "cornerstonemarketingus/atlas", userMessage: "hello", startTasks: async () => [], stream: false, emit: () => {}, fetcher, sleep: async () => {},
  });
  assert.equal(failed.status, 502, "a refused credential is not a rate limit");
  assert.match(failed.error, /@cf\/openai\/gpt-oss-120b \(api\.cloudflare\.com\) rejected Atlas's credential \(401\)/u);
  assert.match(failed.error, /big \(api\.groq\.com\) refused a request larger than its per-minute token allowance/u);
  assert.doesNotMatch(failed.error, /private provider text|cf-workers-ai-token|groq-secret/u);
});
