import assert from "node:assert/strict";
import test from "node:test";

import { callModel } from "../app/api/chat/agent-loop.mjs";
import { chatRoute, resolveChatProvider } from "../app/api/chat/providers.mjs";
import { chatTurns } from "../app/api/chat/turns.mjs";
import { atlasAuthored, qualifiesForTraining, vendorEndpoint } from "../../../packages/atlas-inference/src/catalog.mjs";

// No card, little disk: chat bounces across every free provider the owner has
// a key for. Training tiers (Gemini, OpenRouter, Mistral free) need the
// owner's opt-in and only ever see the person's own words.

const keys = { GROQ_API_KEY: "g", CEREBRAS_API_KEY: "c", GEMINI_API_KEY: "ge", OPENROUTER_API_KEY: "o", MISTRAL_API_KEY: "m" };
const ok = (text = "hello") => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
const turns = chatTurns({ system: "You are Atlas.", message: "What can you do?" });

test("Automatic lists every configured free vendor; training tiers only with the owner's opt-in", () => {
  assert.deepEqual(chatRoute(keys), ["groq", "cerebras"]);
  assert.deepEqual(chatRoute({ ...keys, ATLAS_ALLOW_TRAINING_PROVIDERS: "1" }), ["groq", "cerebras", "gemini", "openrouter", "mistral"]);
  assert.deepEqual(chatRoute({ ...keys, ATLAS_GEMINI_TIER: "paid" }), ["groq", "cerebras", "gemini"], "a paid plan does not train, so it needs no opt-in");
  assert.equal(vendorEndpoint("gemini", { GEMINI_API_KEY: "k", ATLAS_GEMINI_TIER: "paid" }).tier, "vendor", "a paid plan is no-training");
  assert.equal(vendorEndpoint("gemini", { GEMINI_API_KEY: "k", ATLAS_ALLOW_TRAINING_PROVIDERS: "1", ATLAS_GEMINI_MODEL: "gemini-x-flash" }).model, "gemini-x-flash");
});

test("keys only ever travel to their vendor's fixed origin", () => {
  for (let provider = resolveChatProvider({ ...keys, ATLAS_ALLOW_TRAINING_PROVIDERS: "1" }); provider; provider = provider.providerFallback) {
    const origin = new URL(provider.baseUrl).origin;
    const expected = { "https://api.groq.com": "g", "https://api.cerebras.ai": "c", "https://generativelanguage.googleapis.com": "ge", "https://openrouter.ai": "o", "https://api.mistral.ai": "m" }[origin];
    assert.equal(provider.apiKey, expected, origin);
  }
});

test("a refusal from one provider, a rejected key included, bounces to the next", async () => {
  const endpoint = resolveChatProvider(keys);
  const seen = [];
  const fetcher = async (url) => {
    const origin = new URL(url).origin;
    seen.push(origin);
    return origin === "https://api.groq.com" ? Response.json({ error: { message: "Invalid API Key" } }, { status: 401 }) : ok("from cerebras");
  };
  const trail = [];
  const response = await callModel(endpoint, turns, { stream: false, fetcher, trail });
  assert.equal(response.status, 200);
  assert.deepEqual([...new Set(seen)], ["https://api.groq.com", "https://api.cerebras.ai"]);
  assert.ok(trail.some((entry) => entry.status === 401 && entry.category === "credential"), "the rejected key is still reported");
});

test("a training tier gets only Atlas's own system prompt and the person's words; anything else goes elsewhere", async () => {
  const endpoint = resolveChatProvider({ GROQ_API_KEY: "g", GEMINI_API_KEY: "ge", ATLAS_ALLOW_TRAINING_PROVIDERS: "1" });
  const refuse = async (url) => new URL(url).origin === "https://api.groq.com" ? Response.json({ error: { message: "slow down" } }, { status: 429, headers: { "retry-after": "600" } }) : ok("from gemini");
  const sentTo = async (messages) => {
    const seen = new Set();
    await callModel(endpoint, messages, { stream: false, fetcher: async (url, init) => { seen.add(new URL(url).origin); return refuse(url, init); }, trail: [], sleep: async () => {} });
    return seen.has("https://generativelanguage.googleapis.com");
  };
  const [system, question] = turns;
  assert.equal(await sentTo(turns), true);
  assert.equal(await sentTo([...turns, { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] }, { role: "tool", tool_call_id: "1", content: "secret source" }]), false);
  assert.equal(await sentTo(chatTurns({ system: "You are Atlas.", memory: "recent runs", message: "hi" })), false, "workspace memory");
  assert.equal(await sentTo([system, { role: "system", content: "Repository context: src/token.ts" }, question]), false, "a system message Atlas did not register");
  assert.equal(await sentTo([{ role: "system", content: "You are Atlas." }, question]), false, "provenance is recorded, not inferred from content");
  assert.equal(await sentTo(chatTurns({ system: "You are Atlas.", history: [{ role: "user", content: "read my repo" }, { role: "assistant", content: "src/token.ts says..." }], message: "and then?" })), false, "an earlier reply can quote files Atlas read");
});

test("eligibility is decided by provenance, never by what the text looks like (review of #397)", () => {
  const sentinel = 'export function internalToken() { return "EXAMPLE_PRIVATE_SENTINEL"; }';
  const system = atlasAuthored({ role: "system", content: "You are Atlas." });
  // What the person typed reaches the provider whatever it contains: that is the documented consent.
  assert.equal(qualifiesForTraining([system, { role: "user", content: sentinel }]), true);
  // The same text from anywhere else never does.
  assert.equal(qualifiesForTraining([system, { role: "system", content: sentinel }, { role: "user", content: "hi" }]), false);
  assert.equal(qualifiesForTraining([{ role: "system", content: "You are Atlas." }, { role: "user", content: "hi" }]), false);
  assert.equal(qualifiesForTraining([system, { role: "assistant", content: sentinel }, { role: "user", content: "hi" }]), false);
  assert.equal(qualifiesForTraining([system, { role: "tool", content: sentinel }]), false);
  assert.equal(qualifiesForTraining([system, { role: "user", content: [{ type: "text", text: sentinel }] }]), false, "structured content is not the person's plain words");
  assert.equal(qualifiesForTraining([]), false);
});
