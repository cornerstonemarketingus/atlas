import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { normalizeChatMode, hasSuperAtlas, superAtlasEntitlement, resolveChatMode, chatModeChoices, superAtlasFailure } from "../app/api/chat/chat-modes.mjs";
import { chatRoute, paidChatRoute } from "../app/api/chat/providers.mjs";
import { converse } from "../app/api/chat/agent-loop.mjs";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = {}; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }
`)}`, import.meta.url);

const bindings = { ai: { run() {} } };
const local = { ATLAS_CHAT_BASE_URL: "http://127.0.0.1:11434/v1", ATLAS_CHAT_MODEL: "qwen3:0.6b", ATLAS_CHAT_MODELS: "qwen3:1.7b" };
const everyFree = { ...local, GROQ_API_KEY: "groq-secret", CEREBRAS_API_KEY: "cerebras-secret" };
const paid = { OPENAI_API_KEY: "openai-secret" };
const entitled = async () => ({ entitled: true, code: null });
const unentitled = async () => ({ entitled: false, code: "SUBSCRIPTION_REQUIRED" });
const never = async () => assert.fail("the entitlement is not consulted");

function route(endpoint) {
  const hops = [];
  for (let hop = endpoint; hop; hop = hop.providerFallback) hops.push(hop.provider ?? new URL(hop.baseUrl).host);
  return hops;
}

// Ported from #417, with the mode in its own field so `provider` keeps its contract.
test("only the two modes are accepted, and an omitted mode is Atlas", () => {
  for (const value of [undefined, null, "atlas"]) assert.equal(normalizeChatMode(value), "atlas");
  assert.equal(normalizeChatMode("super-atlas"), "super-atlas");
  for (const value of ["auto", "openai", "configured", "workers-ai", "premium", {}, 1]) assert.equal(normalizeChatMode(value), null);
});

test("only an active Pro or Team subscription unlocks Super Atlas; billing faults keep it locked", async () => {
  for (const tier of ["pro", "team"]) assert.equal(hasSuperAtlas({ tier, status: "active" }), true);
  for (const status of ["canceled", "past_due", "trialing", undefined]) assert.equal(hasSuperAtlas({ tier: "pro", status }), false);
  assert.equal(hasSuperAtlas({ tier: "free", status: "active" }), false);
  assert.deepEqual(await superAtlasEntitlement({ dbUserId: null }, never), { entitled: false, code: "SUBSCRIPTION_REQUIRED" });
  assert.deepEqual(await superAtlasEntitlement({ dbUserId: 1 }, () => { throw new Error("D1 down"); }), { entitled: false, code: "ENTITLEMENT_UNAVAILABLE" });
  assert.deepEqual(await superAtlasEntitlement({ dbUserId: 1 }, async () => ({ tier: "free", status: "active" })), { entitled: false, code: "SUBSCRIPTION_REQUIRED" });
  assert.deepEqual(await superAtlasEntitlement({ dbUserId: 1 }, async () => ({ tier: "team", status: "active" })), { entitled: true, code: null });
});

test("Atlas keeps the whole free fabric: rotation, fallbacks and every configured model", async () => {
  const environment = { ...everyFree, ...paid };
  const atlas = await resolveChatMode({ mode: "atlas", environment, bindings, entitlement: never });
  assert.deepEqual(route(atlas.endpoint), route((await resolveChatMode({ mode: "atlas", provider: "auto", environment, bindings, entitlement: never })).endpoint));
  assert.deepEqual(chatRoute(environment, bindings), ["self-hosted", "workers-ai", "groq", "cerebras", "openai"]);
  assert.equal(route(atlas.endpoint).length, 5, "Automatic bounces across every configured provider");
  const picked = await resolveChatMode({ mode: "atlas", provider: "configured:qwen3:1.7b", environment, bindings, entitlement: never });
  assert.equal(picked.endpoint.model, "qwen3:1.7b");
  for (const provider of ["configured", "workers-ai", "openai"]) assert.equal((await resolveChatMode({ mode: "atlas", provider, environment, bindings, entitlement: never })).endpoint.configured, true);
  const unknown = await resolveChatMode({ mode: "atlas", provider: "configured:unknown", environment, bindings, entitlement: never });
  assert.equal(unknown.refusal.status, 400);
});

test("Atlas falls back across free providers when the first refuses", async () => {
  const environment = { GROQ_API_KEY: "groq-secret", CEREBRAS_API_KEY: "cerebras-secret" };
  const { endpoint } = await resolveChatMode({ mode: "atlas", environment, bindings: {}, entitlement: never });
  const hosts = [];
  const outcome = await converse({ endpoint, turns: [{ role: "user", content: "hello" }], stream: false, emit: () => {}, sleep: async () => {},
    fetcher: async (url) => {
      hosts.push(new URL(url).host);
      return new URL(url).host === "api.groq.com" ? Response.json({ error: { message: "invalid key" } }, { status: 401 }) : Response.json({ choices: [{ message: { content: "Free answer." } }] });
    } });
  assert.equal(outcome.reply, "Free answer.");
  assert.ok(hosts.includes("api.cerebras.ai"));
});

test("Super Atlas routes only to paid models, and only for entitled accounts", async () => {
  const environment = { ...everyFree, ...paid, GEMINI_API_KEY: "gemini-secret", ATLAS_GEMINI_TIER: "paid", ATLAS_GEMINI_MODEL: "gemini-2.5-pro", MISTRAL_API_KEY: "mistral-secret" };
  const { endpoint } = await resolveChatMode({ mode: "super-atlas", environment, bindings, entitlement: entitled });
  assert.deepEqual(route(endpoint), ["openai", "gemini"], "no free, local or training-tier provider is in the paid route");
  assert.equal(endpoint.model, "gpt-5.4-mini");
  assert.equal(endpoint.providerFallback.model, "gemini-2.5-pro");
  assert.equal(endpoint.providerFallback.tier, "vendor");
  // A main model on the OpenAI API is the operator's own paid choice and leads.
  const operator = paidChatRoute({ ATLAS_CHAT_BASE_URL: "https://api.openai.com/v1", ATLAS_CHAT_MODEL: "gpt-5.4", ...paid });
  assert.equal(operator.model, "gpt-5.4");
  assert.equal(operator.apiKey, "openai-secret");
  assert.equal(operator.providerFallback, undefined, "one provider per origin");
  const refused = await resolveChatMode({ mode: "super-atlas", environment, bindings, entitlement: unentitled });
  assert.equal(refused.refusal.status, 403);
  assert.equal(refused.refusal.body.code, "SUBSCRIPTION_REQUIRED");
  assert.equal(refused.refusal.body.fallbackMode, "atlas");
  assert.equal(refused.refusal.body.upgradeUrl, "/pricing");
  assert.match(refused.refusal.body.message, /Pro or Team.*choose Atlas/su);
  const choice = await resolveChatMode({ mode: "super-atlas", provider: "configured:qwen3:1.7b", environment, bindings, entitlement: never });
  assert.equal(choice.refusal.status, 400);
});

test("Super Atlas on a deployment with no paid model says so, offers Atlas, and never asks for a subscription", async () => {
  const environment = { ...everyFree, GEMINI_API_KEY: "gemini-secret", ATLAS_ALLOW_TRAINING_PROVIDERS: "1" };
  assert.equal(paidChatRoute(environment), null);
  const { refusal } = await resolveChatMode({ mode: "super-atlas", environment, bindings, entitlement: never });
  assert.equal(refusal.status, 503);
  assert.equal(refusal.body.code, "SUPER_ATLAS_NOT_CONFIGURED");
  assert.equal(refusal.body.fallbackMode, "atlas");
  assert.equal(refusal.body.needsModelEndpoint, undefined, "free Atlas is still connected");
  const [atlas, superAtlas] = await chatModeChoices({ environment, bindings, entitlement: never });
  assert.equal(atlas.available, true);
  assert.deepEqual([superAtlas.available, superAtlas.configured, superAtlas.code], [false, false, "SUPER_ATLAS_NOT_CONFIGURED"]);
  assert.equal(JSON.stringify([atlas, superAtlas]).includes("secret"), false);
});

test("the mode catalog says why Super Atlas is locked and when it is open", async () => {
  const environment = { ...everyFree, ...paid };
  const locked = (await chatModeChoices({ environment, bindings, entitlement: unentitled }))[1];
  assert.deepEqual([locked.available, locked.configured, locked.entitled, locked.code, locked.upgradeUrl], [false, true, false, "SUBSCRIPTION_REQUIRED", "/pricing"]);
  const faulted = (await chatModeChoices({ environment, bindings, entitlement: async () => ({ entitled: false, code: "ENTITLEMENT_UNAVAILABLE" }) }))[1];
  assert.match(faulted.reason, /could not confirm/u);
  const open = (await chatModeChoices({ environment, bindings, entitlement: entitled }))[1];
  assert.deepEqual([open.available, open.reason, open.code], [true, null, null]);
  assert.equal(JSON.stringify(open).includes("openai-secret"), false);
});

test("no silent downgrade: when every paid model refuses, Super Atlas fails without calling a free provider", async () => {
  const environment = { ...everyFree, ...paid, GEMINI_API_KEY: "gemini-secret", ATLAS_GEMINI_TIER: "paid" };
  const { endpoint } = await resolveChatMode({ mode: "super-atlas", environment, bindings, entitlement: entitled });
  const hosts = [];
  const outcome = await converse({ endpoint, turns: [{ role: "user", content: "hello" }], stream: false, emit: () => {}, sleep: async () => {},
    fetcher: async (url) => { hosts.push(new URL(url).host); return Response.json({ error: { message: "rejected" } }, { status: 401 }); } });
  assert.ok("error" in outcome);
  assert.ok(hosts.length > 0);
  assert.deepEqual([...new Set(hosts)].sort(), ["api.openai.com", "generativelanguage.googleapis.com"]);
  const failure = superAtlasFailure(outcome.error);
  assert.equal(failure.code, "SUPER_ATLAS_UNAVAILABLE");
  assert.equal(failure.fallbackMode, "atlas");
  assert.match(failure.message, /did not switch to a free model/u);
});

test("the built chat route offers both modes and refuses Super Atlas honestly before any write or model call", async (t) => {
  const configuration = { ATLAS_OPERATOR_TOKEN: "test-chat-modes", ...local, ATLAS_CHAT_FALLBACK_MODEL: "none" };
  const previous = Object.fromEntries([...Object.keys(configuration), "OPENAI_API_KEY"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  delete process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return JSON.parse(options.body).stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const context = { waitUntil() {}, passThroughOnException() {} };
  const headers = { authorization: "Bearer test-chat-modes", "content-type": "application/json" };
  const invoke = (method, body) => worker.fetch(new Request("http://localhost/api/chat", { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, context);

  const catalog = await (await invoke("GET")).json();
  assert.deepEqual(catalog.modes.map((choice) => [choice.id, choice.available]), [["atlas", true], ["super-atlas", false]]);
  assert.equal(catalog.modes[1].code, "SUPER_ATLAS_NOT_CONFIGURED");
  assert.ok(catalog.providers.some((choice) => choice.id === "configured:qwen3:1.7b"), "the configured-model contract is unchanged");

  const unknown = await invoke("POST", { message: "Hello", mode: "premium" });
  assert.equal(unknown.status, 400);
  const notConfigured = await invoke("POST", { message: "Hello", mode: "super-atlas" });
  assert.equal(notConfigured.status, 503);
  assert.deepEqual(await notConfigured.json().then((body) => [body.code, body.fallbackMode, body.needsModelEndpoint]), ["SUPER_ATLAS_NOT_CONFIGURED", "atlas", undefined]);

  process.env.OPENAI_API_KEY = "openai-secret";
  // An operator token is not a subscription (as #417 decided): locked, with the way back to Atlas.
  const locked = await invoke("POST", { message: "Hello", mode: "super-atlas", stream: true });
  assert.equal(locked.status, 403);
  const body = await locked.json();
  assert.deepEqual([body.code, body.fallbackMode, body.upgradeUrl], ["SUBSCRIPTION_REQUIRED", "atlas", "/pricing"]);
  assert.equal(JSON.stringify(body).includes("openai-secret"), false);
  assert.equal(calls.length, 0, "a refused Super Atlas turn never reaches any model, free or paid");

  const free = await invoke("POST", { message: "Hello", mode: "atlas", provider: "configured:qwen3:1.7b" });
  assert.equal(free.status, 200);
  assert.equal((await free.json()).reply.content, "Hello");
  assert.equal(new URL(calls[0]).host, "127.0.0.1:11434");
});
