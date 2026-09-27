import assert from "node:assert/strict";
import test from "node:test";
import { callModel, converse } from "../app/api/chat/agent-loop.mjs";
import { resolveChatModel } from "../app/api/chat/model-endpoint.mjs";
import { eligibleTargets, ModelRecoveryState, rateLimitEvidence, recoveryForScope, resetMs } from "../app/api/chat/model-recovery.mjs";

const free = { inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 };
const extra = (overrides = {}) => ({ id: "alternate", provider: "other", baseUrl: "https://other.test/v1", model: "other-model", apiKeyEnv: "OTHER_KEY", policyAllowed: true,
  cost: free, capabilities: { toolCalls: true, contextTokens: 100_000, maxOutputTokens: 4096 }, ...overrides });
function endpoint(targets = [extra()], env = {}) {
  return resolveChatModel({ ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "strong", GROQ_API_KEY: "primary-secret", OTHER_KEY: "other-secret",
    ATLAS_CHAT_TARGETS: JSON.stringify(targets), ...env });
}
const turns = [{ role: "user", content: "sensitive user content" }];
const limited = (headers = { "retry-after": "60" }) => new Response("sensitive echoed prompt", { status: 429, headers });
const answer = (text = "done", calls = []) => Response.json({ choices: [{ message: { content: text, tool_calls: calls } }] });

test("numeric/date Retry-After and compound Groq resets retain authoritative waits", () => {
  assert.equal(resetMs("2m59.5s"), 179500);
  assert.equal(resetMs("250ms"), 250);
  assert.equal(resetMs("bad"), null);
  const now = Date.parse("2026-09-27T00:00:00Z");
  assert.equal(rateLimitEvidence(new Headers({ "retry-after": "Sun, 27 Sep 2026 00:00:30 GMT" }), { now }).waitMs, 30_000);
  assert.equal(rateLimitEvidence(new Headers({ "retry-after": "1.5" })).waitMs, 1500);
  const both = rateLimitEvidence(new Headers({ "retry-after": "1", "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "2m", "x-ratelimit-reset-requests": "250ms" }));
  assert.equal(both.waitMs, 120_000);
  assert.equal(both.category, "tokens");
  assert.equal(rateLimitEvidence(new Headers({ "x-ratelimit-reset-requests": "1.5s" })).waitMs, 1500);
  assert.equal(rateLimitEvidence(new Headers({ "retry-after": "-1" }), { random: () => 1 }).waitMs, 1000);
  const insufficient = rateLimitEvidence(new Headers({ "x-ratelimit-remaining-tokens": "100", "x-ratelimit-reset-tokens": "30s" }), { inputTokenEstimate: 500 });
  assert.equal(insufficient.category, "tokens");
  assert.equal(insufficient.waitMs, 30_000);
});

test("unknown limits use bounded exponential jitter rather than an immediate identical retry", () => {
  const delays = [1, 2, 3, 20].map((attempt) => rateLimitEvidence(new Headers(), { attempt, random: () => 1 }).waitMs);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(rateLimitEvidence(new Headers(), { random: () => 0 }).waitMs, 500);
  for (const category of ["rpm", "rpd", "tpm", "tpd", "input_tokens", "output_tokens", "concurrency", "capacity"]) {
    assert.equal(rateLimitEvidence(new Headers({ "x-ratelimit-category": category })).category, category);
  }
});

test("primary and sibling exhaustion continues to another provider with only its own key", async () => {
  const requests = [];
  const events = [];
  const config = endpoint();
  const result = await callModel(config, turns, { stream: false, fetcher: async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect });
    return requests.length < 3 ? limited() : answer();
  }, onRecovery: (event) => events.push(event), turnId: "turn-1" });
  assert.equal(result.status, 200);
  assert.deepEqual(requests.map((request) => request.body.model), ["strong", "openai/gpt-oss-20b", "other-model"]);
  assert.equal(requests[2].headers.authorization, "Bearer other-secret");
  assert.equal(requests[0].headers.authorization, "Bearer primary-secret");
  assert.equal(requests[2].redirect, "error");
  const serialized = JSON.stringify(events);
  for (const secret of ["primary-secret", "other-secret", "sensitive user content", "sensitive echoed prompt", "https://"]) assert.ok(!serialized.includes(secret));
  assert.equal(events.find((event) => event.httpStatus === 429).turnId, "turn-1");
  assert.ok(events.find((event) => event.httpStatus === 429).inputTokenEstimate > 0);
});

test("provider-wide limits skip sibling models and temporary state expires", async () => {
  let now = 1000;
  const state = new ModelRecoveryState({ now: () => now });
  const config = { ...endpoint(), recoveryState: state };
  const models = [];
  const fetcher = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    models.push(model);
    return model === "strong" ? limited({ "retry-after": "60", "x-ratelimit-scope": "provider" }) : answer();
  };
  await callModel(config, turns, { fetcher });
  await callModel(config, turns, { fetcher });
  assert.deepEqual(models, ["strong", "other-model", "other-model"]);
  now += 60_001;
  await callModel(config, turns, { fetcher });
  assert.equal(models[3], "strong");
});

test("token and daily limits do not resend identical context after a short sleep", async () => {
  for (const category of ["tpm", "rpd", "tpd", "input_tokens", "output_tokens"]) {
    const models = [];
    await callModel(endpoint(), turns, { sleep: async () => assert.fail("should switch"), fetcher: async (_url, init) => {
      const model = JSON.parse(init.body).model; models.push(model);
      return model === "strong" ? limited({ "retry-after": "1", "x-ratelimit-category": category }) : answer();
    } });
    assert.deepEqual(models, ["strong", "openai/gpt-oss-20b"]);
  }
  const state = new ModelRecoveryState({ now: () => 1000 });
  const target = eligibleTargets(endpoint(), { turns }).targets[0];
  state.record(target, 429, new Headers({ "x-ratelimit-category": "rpd" }));
  assert.equal(state.availability(target).until, 86_401_000);
});

test("policy, capability, locality and known cost filter targets before transmission", () => {
  const config = endpoint([
    extra({ id: "denied", policyAllowed: false }), extra({ id: "unknownCost", cost: null }),
    extra({ id: "noTools", model: "noTools", capabilities: { toolCalls: false } }),
    extra({ id: "tooSmall", model: "tooSmall", capabilities: { toolCalls: true, contextTokens: 10 } }),
    extra({ id: "paid", model: "paid", cost: { inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000 } }),
    extra({ id: "local", provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "local", apiKeyEnv: undefined }),
  ], { ATLAS_CHAT_ROUTING_POLICY: "LOCAL_ONLY" });
  assert.equal(config.configured, true);
  assert.deepEqual(eligibleTargets(config, { turns, tools: [{}] }).targets.map((target) => target.id), ["local"]);
  config.routingPolicy = "BALANCED";
  assert.deepEqual(eligibleTargets(config, { turns, tools: [{}] }).targets.map((target) => target.id), ["primary", "fallback", "local"]);
});

test("unknown remote prices and missing credential references are not treated as free", () => {
  for (const target of [extra({ cost: null }), extra({ apiKeyEnv: "MISSING_KEY" })]) {
    assert.deepEqual(eligibleTargets(endpoint([target]), { turns }).targets.map((item) => item.id), ["primary", "fallback"]);
  }
});

test("new endpoints retain HTTPS, URL and locality restrictions without echoing secrets", () => {
  for (const baseUrl of ["http://other.test/v1", "https://user:secret@other.test/v1", "https://other.test/v1?key=secret", "ftp://localhost/v1"]) {
    const result = endpoint([extra({ baseUrl })]);
    assert.equal(result.configured, false);
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
  assert.equal(endpoint([extra({ local: true })]).configured, false);
  assert.equal(endpoint([extra({ apiKey: "inline-secret" })]).configured, false);
  assert.equal(endpoint([extra({ cost: { inputMicroUsdPerMillion: -1, outputMicroUsdPerMillion: 0 } })]).configured, false);
  assert.equal(endpoint([extra()], { ATLAS_CHAT_TARGET_ORDER: '["alternate"]' }).configured, false);
});

test("target ordering is configurable; local preference does not leak a remote credential", async () => {
  const local = extra({ id: "local", provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKeyEnv: undefined });
  const config = endpoint([local], { ATLAS_CHAT_ROUTING_POLICY: "PREFER_LOCAL" });
  await callModel(config, turns, { fetcher: async (url, init) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1/u);
    assert.equal(init.headers.authorization, undefined);
    return answer();
  } });
  const ordered = endpoint([extra()], { ATLAS_CHAT_TARGET_ORDER: '["alternate","primary","fallback"]' });
  assert.deepEqual(eligibleTargets(ordered, { turns }).targets.map((target) => target.id), ["alternate", "primary", "fallback"]);
});

test("paid recovery needs permission and reserves estimated cost before each attempt", async () => {
  const paid = extra({ cost: { inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000 } });
  const env = { ATLAS_CHAT_TARGET_ORDER: '["alternate","primary","fallback"]', ATLAS_CHAT_ALLOW_PAID_RECOVERY: "true", ATLAS_CHAT_RECOVERY_BUDGET_MICRO_USD: "3000" };
  const config = endpoint([paid], env);
  const events = [];
  const models = [];
  await callModel(config, turns, { onRecovery: (event) => events.push(event), fetcher: async (_url, init) => {
    assert.ok(config.recoveryBudget.spentMicroUsd > 0);
    const model = JSON.parse(init.body).model; models.push(model);
    if (model === "other-model") return limited();
    return answer();
  } });
  assert.deepEqual(models, ["other-model", "strong"]);
  assert.ok(events[0].estimatedCostMicroUsd > 2000);
  assert.ok(config.recoveryBudget.spentMicroUsd <= 3000);
  assert.ok(!eligibleTargets(config, { turns }).targets.some((target) => target.id === "alternate"));
  const denied = endpoint([paid], { ...env, ATLAS_CHAT_ALLOW_PAID_RECOVERY: "false" });
  assert.ok(!eligibleTargets(denied, { turns }).targets.some((target) => target.id === "alternate"));
});

test("successful tool work and call/result pairing survive provider recovery and later rounds", async () => {
  const requests = [];
  let toolRuns = 0;
  const config = endpoint();
  const outcome = await converse({ endpoint: config, turns, toolContext: {}, emit: () => {}, stream: false, allowTasks: false,
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    handlers: { lookup: async () => { toolRuns++; return { ok: true, label: "Checked", content: "verified finding" }; } },
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      if (requests.length === 1) return answer("Checking", [{ id: "t1", function: { name: "lookup", arguments: "{}" } }]);
      if (["strong", "openai/gpt-oss-20b"].includes(body.model)) return limited();
      assert.equal(body.messages.at(-1).content, "verified finding");
      assert.equal(body.messages.at(-1).tool_call_id, "t1");
      return answer("Finished");
    } });
  assert.equal(toolRuns, 1);
  assert.equal(outcome.reply, "Checking\n\nFinished");
  assert.deepEqual(requests.map((request) => request.model), ["strong", "strong", "openai/gpt-oss-20b", "other-model"]);
});

test("network outages and temporary capacity failures advance to permitted alternatives", async () => {
  for (const failure of [() => { throw new TypeError("secret in network error"); }, () => new Response(null, { status: 503 })]) {
    let requests = 0;
    const result = await callModel(endpoint(), turns, { fetcher: async () => ++requests === 1 ? failure() : answer() });
    assert.equal(result.status, 200);
    assert.equal(requests, 2);
  }
});

test("cancellation during backoff prevents every subsequent request", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(callModel(endpoint(), turns, { signal: controller.signal, sleep: async () => controller.abort(), fetcher: async () => { calls++; return limited({ "retry-after": "1" }); } }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("bounded history and scope separation prevent cross-tenant cooldown sharing", () => {
  assert.notEqual(recoveryForScope("tenant-a:user"), recoveryForScope("tenant-b:user"));
  assert.equal(recoveryForScope("tenant-a:user"), recoveryForScope("tenant-a:user"));
  const state = new ModelRecoveryState();
  const target = eligibleTargets(endpoint(), { turns }).targets[0];
  for (let n = 0; n < 150; n++) state.record(target, 429, new Headers());
  assert.equal(state.history().length, 128);
  const events = state.history(); events[0].category = "changed";
  assert.notEqual(state.history()[0].category, "changed");
});

test("recovery does not switch after a successful response has started streaming", async () => {
  let calls = 0;
  const outcome = await converse({ endpoint: endpoint(), turns, toolContext: {}, stream: true, emit: () => {}, tools: [], allowTasks: false,
    fetcher: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("broken stream")); } }), { headers: { "content-type": "text/event-stream" } });
    } });
  assert.equal(calls, 1);
  assert.ok(outcome.error);
});

test("parallel team requests cannot spend the same paid reservation twice", async () => {
  const config = endpoint([extra({ cost: { inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000 } })], {
    ATLAS_CHAT_ALLOW_PAID_RECOVERY: "true", ATLAS_CHAT_RECOVERY_BUDGET_MICRO_USD: "3000", ATLAS_CHAT_TARGET_ORDER: '["alternate","primary","fallback"]',
  });
  const models = [];
  const fetcher = async (_url, init) => { models.push(JSON.parse(init.body).model); await Promise.resolve(); return answer(); };
  await Promise.all([callModel(config, turns, { fetcher }), callModel(config, turns, { fetcher })]);
  assert.deepEqual(models, ["other-model", "strong"]);
  assert.ok(config.recoveryBudget.spentMicroUsd < 3000);
});

test("all cooling targets cause no repeat requests and resume only after expiry", async () => {
  let now = 1000;
  const config = { ...endpoint([]), recoveryState: new ModelRecoveryState({ now: () => now }) };
  let calls = 0;
  const fetcher = async () => { calls++; return limited(); };
  assert.equal((await callModel(config, turns, { fetcher })).status, 429);
  assert.equal((await callModel(config, turns, { fetcher })).status, 429);
  assert.equal(calls, 2);
  now += 60_001;
  await callModel(config, turns, { fetcher });
  assert.equal(calls, 4);
});
