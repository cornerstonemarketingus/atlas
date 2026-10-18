import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ATTEMPTS_PER_REPLY, MAX_ATTEMPTS_PER_STEP, callModel, converse } from "../app/api/chat/agent-loop.mjs";
import { chatGovernor } from "../app/api/inference/governor-client.mjs";
import { createGovernorCore, handleGovernorRequest } from "../worker/inference-governor-core.mjs";

/**
 * Deterministic chaos and load harness. No network, no provider spend.
 *
 * - Providers are fakes with real-looking behavior: a per-minute token
 *   allowance that refuses with an exact reset, billing exhaustion, outages,
 *   malformed and empty replies, SSE streams that fail part-way.
 * - The quota ledger is the real one (the Durable Object's core) behind the
 *   real governor wire protocol, one per provider scope. A mutex stands in for
 *   the Durable Object's one-request-at-a-time guarantee.
 * - Time is virtual: sleeping advances a clock shared by providers and ledger.
 */
const MINUTE = 60_000;
const SECRET = "sk-test-secret-0123456789";

function world() {
  const clock = { now: 0 };
  const cores = new Map();
  const providers = new Map();
  const logs = [];
  const sleep = async (ms) => { clock.now += ms; await new Promise((resolve) => setImmediate(resolve)); };
  const scope = (origin) => {
    if (!cores.has(origin)) {
      const store = new Map();
      const core = createGovernorCore({ storage: { get: async (key) => store.get(key), put: async (key, value) => { store.set(key, structuredClone(value)); }, setAlarm: async () => {} }, now: () => clock.now });
      let chain = Promise.resolve();
      const stub = { fetch: (request) => { const run = chain.then(() => handleGovernorRequest(core, request)); chain = run.catch(() => {}); return run; } };
      cores.set(origin, { core, stub });
    }
    return cores.get(origin);
  };
  const governor = (origin, latencyClass = "INTERACTIVE") => chatGovernor(scope(origin).stub, { latencyClass });
  const provider = (origin, options = {}) => {
    const p = { origin, calls: 0, refused429: 0, toolRequests: 0, windowStart: 0, used: options.preUsed ?? 0, tpm: options.tpm ?? Infinity, seenAt: [], ...options };
    providers.set(origin, p);
    return p;
  };
  const headers = (p) => (Number.isFinite(p.tpm) ? { "x-ratelimit-limit-tokens": String(p.tpm), "x-ratelimit-remaining-tokens": String(Math.max(0, p.tpm - p.used)), "x-ratelimit-reset-tokens": `${Math.max(1, Math.ceil((p.windowStart + MINUTE - clock.now) / 1000))}s` } : {});
  const reply = (p, body) => {
    const asked = body.tools && !body.messages.some((message) => message.role === "tool") && p.callsTool;
    const message = asked ? { content: null, tool_calls: [{ id: `c-${p.calls}`, type: "function", function: { name: "lookup", arguments: "{}" } }] } : { content: `answer from ${p.origin}` };
    if (body.stream) return sse(p, message);
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: asked ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { "content-type": "application/json", ...headers(p) } });
  };
  const sse = (p, message) => {
    const events = message.tool_calls
      ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: message.tool_calls[0].id, function: { name: "lookup", arguments: "{}" } }] } }] }]
      : [{ choices: [{ delta: { content: message.content.slice(0, 7) } }] }, { choices: [{ delta: { content: message.content.slice(7) } }] }];
    const encoder = new TextEncoder();
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (p.streamBreaksAfter !== undefined && index >= p.streamBreaksAfter) { controller.error(new Error("connection reset")); return; }
        if (index < events.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`));
        else { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); }
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", ...headers(p) } });
  };
  const fetcher = async (url, init) => {
    const p = providers.get(new URL(url).origin);
    const body = JSON.parse(init.body);
    p.calls += 1;
    p.seenAt.push(clock.now);
    if (body.tools) p.toolRequests += 1;
    (p.requests ??= []).push(body);
    if (p.behavior) { const forced = p.behavior(p, body, clock.now); if (forced) return forced; }
    if (p.billing) return new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }), { status: 429 });
    if (p.blockedUntil && clock.now < p.blockedUntil) { p.refused429 += 1; return new Response("Rate limit reached.", { status: 429, headers: { "retry-after": String(Math.ceil((p.blockedUntil - clock.now) / 1000)) } }); }
    if (clock.now >= p.windowStart + MINUTE) { p.windowStart = Math.floor(clock.now / MINUTE) * MINUTE; p.used = 0; }
    const tokens = Math.ceil(JSON.stringify([body.messages, body.tools ?? null]).length / 4) + (body.max_tokens ?? 0);
    if (p.used + tokens > p.tpm) {
      p.refused429 += 1;
      return new Response(JSON.stringify({ error: { message: "Rate limit reached for tokens per minute (TPM)" } }), { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil((p.windowStart + MINUTE - clock.now) / 1000))), ...headers(p) } });
    }
    p.used += tokens;
    p.maxUsed = Math.max(p.maxUsed ?? 0, p.used);
    return reply(p, body);
  };
  const chain = (specs) => {
    const [first, ...rest] = specs;
    const endpoint = { configured: true, baseUrl: `${first.origin}/v1/`, model: first.model ?? "m", apiKey: SECRET, fallbackModel: first.fallbackModel ?? null, capabilities: first.capabilities, models: first.models, governor: first.ungoverned ? null : governor(first.origin) };
    return rest.length ? { ...endpoint, providerFallback: chain(rest) } : endpoint;
  };
  const logger = (event, fields) => logs.push(JSON.stringify({ event, ...fields }));
  return { clock, sleep, scope, provider, providers, fetcher, chain, logs, logger };
}

const lookupTool = [{ type: "function", function: { name: "lookup", description: "look something up", parameters: { type: "object", properties: {} } } }];
const handlers = { lookup: async () => ({ ok: true, label: "Looked it up", content: "a short result" }) };
const user = (text) => [{ role: "system", content: "You are Atlas." }, { role: "user", content: text }];

async function ask(w, endpoint, { text = "hello", tools = false, agentId, stream = false, maxTokens } = {}) {
  const physical = { n: 0 };
  const result = await converse({
    endpoint, turns: user(text), userMessage: text, stream, emit: () => {}, allowTasks: false, ...(maxTokens ? { maxTokens } : {}),
    tools: tools ? lookupTool : [], handlers: tools ? handlers : {}, sleep: w.sleep, ...(agentId ? { agentId } : {}),
    fetcher: (url, init) => { physical.n += 1; return w.fetcher(url, init); },
  });
  return { ...result, physical: physical.n };
}

async function settled(w) {
  const reservations = {};
  for (const [origin, { core }] of w.providers.size ? [...w.providers.keys()].map((origin) => [origin, w.scope(origin)]) : []) {
    const snapshot = await core.snapshot();
    reservations[origin] = { reservations: snapshot.reservations, waiting: snapshot.waiting.length };
  }
  return reservations;
}

test("50 concurrent mixed requests over a nearly exhausted, a briefly limited, a bankrupt, an incapable and a healthy provider: every one is answered within budget", async (t) => {
  const w = world();
  const a = w.provider("https://a.test", { tpm: 6_000, preUsed: 5_900 });
  const b = w.provider("https://b.test", { tpm: 30_000, blockedUntil: 5_000, callsTool: true });
  const x = w.provider("https://x.test", { callsTool: false });
  const c = w.provider("https://c.test", { billing: true });
  const d = w.provider("https://d.test", { tpm: 90_000, callsTool: true });
  a.callsTool = true;
  const warn = console.warn; const log = console.log; const captured = [];
  console.warn = (...args) => captured.push(args.join(" ")); console.log = (...args) => captured.push(args.join(" "));
  t.after(() => { console.warn = warn; console.log = log; });
  const route = () => w.chain([
    { origin: a.origin, model: "a-main", fallbackModel: "a-small" },
    { origin: b.origin, model: "b-main", fallbackModel: "b-small" },
    { origin: x.origin, model: "x-main", capabilities: { tools: false, streaming: true } },
    { origin: c.origin, model: "c-main" },
    { origin: d.origin, model: "d-main" },
  ]);
  const kinds = [
    (i) => ({ text: `simple question ${i}` }),
    (i) => ({ text: `look this up ${i}`, tools: true }),
    (i) => ({ text: `agent subtask ${i}`, tools: true, agentId: `child-${i}` }),
    (i) => ({ text: `write this module ${i}: ${"function body ".repeat(250)}` }),
  ];
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => ask(w, route(), kinds[i % kinds.length](i))));

  assert.equal(results.length, 50);
  for (const [index, result] of results.entries()) {
    assert.equal(typeof result.reply, "string", `request ${index} reached a terminal answer: ${JSON.stringify(result).slice(0, 160)}`);
    assert.ok(result.reply.length > 0 && !result.error, `request ${index} answered`);
    assert.ok(result.physical <= MAX_ATTEMPTS_PER_REPLY + MAX_ATTEMPTS_PER_STEP * 2, `request ${index} made ${result.physical} provider calls`);
  }
  assert.equal(x.toolRequests, 0, "an incapable target is never sent a tool request");
  assert.ok(c.calls <= 5, `the bankrupt provider was tried ${c.calls} times, not once per request`);
  assert.ok(a.maxUsed === undefined || a.maxUsed <= a.tpm, "no provider allowance was exceeded");
  assert.ok(d.maxUsed <= d.tpm && b.maxUsed <= b.tpm);
  assert.ok(a.refused429 + b.refused429 + d.refused429 <= 15, `provider 429s stay a small fraction (${a.refused429 + b.refused429 + d.refused429})`);
  for (const [origin, state] of Object.entries(await settled(w))) assert.deepEqual(state, { reservations: 0, waiting: 0 }, `${origin} leaked nothing`);
  const everything = JSON.stringify(results) + captured.join("\n");
  assert.ok(!everything.includes(SECRET), "no credential appears in results or logs");
  assert.ok(!/Bearer |insufficient_quota|tokens per minute/iu.test(JSON.stringify(results.map((result) => result.reply))), "no raw provider text reaches a reply");
  assert.ok(w.clock.now < 4 * MINUTE, "waiting stayed within a few minutes of virtual time");
});

test("a permanently broken account is not hammered: ten sequential requests reach it once", async () => {
  const w = world();
  const c = w.provider("https://c.test", { billing: true });
  const d = w.provider("https://d.test", {});
  for (let i = 0; i < 10; i += 1) {
    const result = await ask(w, w.chain([{ origin: c.origin, model: "c1", fallbackModel: "c2", models: ["c1", "c2", "c3"] }, { origin: d.origin, model: "d" }]), { text: `q${i}` });
    assert.match(result.reply, /answer from https:\/\/d\.test/u);
  }
  assert.equal(w.clock.now, 0, "a known-dead account is skipped at once, with no waiting");
  assert.equal(c.calls, 1, "billing exhaustion is learned once for the whole account, models never tried included");
  assert.equal(d.calls, 10);
});

test("an account without credit and no other target ends quickly, accurately, and without sleeping", async () => {
  const w = world();
  const c = w.provider("https://c.test", { billing: true });
  const slept = [];
  const result = await converse({ endpoint: w.chain([{ origin: c.origin, model: "c" }]), turns: user("hi"), stream: false, emit: () => {}, allowTasks: false, tools: [], fetcher: w.fetcher, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(result.status, 429);
  assert.match(result.error, /no available API credits|billing/iu);
  assert.doesNotMatch(result.error, /try again|wait and ask again/iu, "no false promise that waiting helps");
  assert.deepEqual(slept, []);
  assert.equal(c.calls, 1);
});

test("a stated reset is waited out exactly, and no provider call happens before it", async () => {
  const w = world();
  const p = w.provider("https://p.test", { blockedUntil: 4_000 });
  const result = await ask(w, w.chain([{ origin: p.origin, model: "m" }]));
  assert.match(result.reply, /answer from/u);
  assert.ok(p.seenAt.length >= 2 && p.seenAt[1] >= 4_000, `the retry came at ${p.seenAt[1]}ms, after the 4s reset`);
  assert.ok(p.calls <= 3);
});

test("a request bigger than a target's whole per-minute allowance is routed away before it is sent", async () => {
  const w = world();
  const small = w.provider("https://small.test", { tpm: 6_000 });
  const large = w.provider("https://large.test", { tpm: 100_000 });
  const first = await ask(w, w.chain([{ origin: small.origin, model: "s" }, { origin: large.origin, model: "l" }]), { text: "short" });
  assert.match(first.reply, /small\.test/u, "the small target answers what fits and teaches the ledger its allowance");
  const before = { calls: small.calls, refused: small.refused429 };
  const big = await ask(w, w.chain([{ origin: small.origin, model: "s" }, { origin: large.origin, model: "l" }]), { text: "long ".repeat(12_000), maxTokens: 2048 });
  assert.match(big.reply, /large\.test/u);
  assert.deepEqual({ calls: small.calls, refused: small.refused429 }, before, "the oversized request never reached the small target, so it never earned a 429");
  assert.equal(w.clock.now, 0, "and nobody waited for a model it could never fit");
});

test("a target without the needed capability is skipped, not tried and not waited for", async () => {
  const w = world();
  const down = w.provider("https://down.test", { behavior: () => new Response("unavailable", { status: 503 }) });
  const noTools = w.provider("https://notools.test", {});
  const tiny = w.provider("https://tiny.test", {});
  const good = w.provider("https://good.test", { callsTool: true });
  const result = await ask(w, w.chain([
    { origin: down.origin, model: "d" },
    { origin: noTools.origin, model: "n", capabilities: { tools: false } },
    { origin: tiny.origin, model: "t", capabilities: { contextTokens: 500 } },
    { origin: good.origin, model: "g" },
  ]), { text: "use the tool please", tools: true });
  assert.match(result.reply, /good\.test/u);
  assert.deepEqual([noTools.calls, tiny.calls], [0, 0]);
});

test("a provider outage everywhere ends in a bounded number of calls with an honest answer", async () => {
  const w = world();
  const specs = ["a", "b", "c"].map((name) => w.provider(`https://${name}.test`, { behavior: () => new Response("bad gateway", { status: 502 }) }));
  const result = await ask(w, w.chain(specs.map((p) => ({ origin: p.origin, model: "m", fallbackModel: "m2" }))), { tools: true });
  assert.ok(result.error || /could not|unable|no model/iu.test(result.reply ?? ""), "it says what happened");
  const total = specs.reduce((sum, p) => sum + p.calls, 0);
  assert.ok(total <= MAX_ATTEMPTS_PER_REPLY + MAX_ATTEMPTS_PER_STEP * 2, `${total} provider calls for one request`);
});

test("transient chaos (500, timeout, malformed and empty 200s) recovers on the next target without surfacing an error", async () => {
  for (const [name, behavior] of [
    ["500", () => new Response("boom", { status: 500 })],
    ["503", () => new Response("down", { status: 503 })],
    ["timeout", () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }],
    ["network", () => { throw new TypeError("fetch failed"); }],
    ["malformed", () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "application/json" } })],
    ["empty 200", () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } })],
  ]) {
    const w = world();
    const bad = w.provider("https://bad.test", { behavior });
    const good = w.provider("https://good.test", {});
    const result = await ask(w, w.chain([{ origin: bad.origin, model: "m" }, { origin: good.origin, model: "g" }]));
    assert.match(result.reply ?? "", /answer from/u, `${name} recovered: ${JSON.stringify(result).slice(0, 120)}`);
    assert.ok(result.physical <= 8, `${name}: ${result.physical} calls`);
  }
});

test("streaming: a failure before the first token falls over; one after visible text never splices another model's answer", async () => {
  const w = world();
  const early = w.provider("https://early.test", { behavior: () => new Response("down", { status: 503 }) });
  const good = w.provider("https://good.test", {});
  const before = await ask(w, w.chain([{ origin: early.origin, model: "e" }, { origin: good.origin, model: "g" }]), { stream: true });
  assert.equal(before.reply, "answer from https://good.test");

  const w2 = world();
  const broken = w2.provider("https://broken.test", { streamBreaksAfter: 1 });
  const spare = w2.provider("https://spare.test", {});
  const emitted = [];
  const result = await converse({ endpoint: w2.chain([{ origin: broken.origin, model: "b" }, { origin: spare.origin, model: "s" }]), turns: user("hi"), stream: true, emit: (type, data) => { if (type === "delta") emitted.push(data.text); }, allowTasks: false, tools: [], fetcher: w2.fetcher, sleep: w2.sleep });
  const shown = emitted.join("");
  assert.ok(!(shown.includes("answer") && shown.includes("spare.test")), `no mixed-model text: ${shown}`);
  assert.ok(typeof result.reply === "string" || result.error, "the request still ends in a terminal state");
  for (const [origin, state] of Object.entries(await settled(w2))) assert.deepEqual(state, { reservations: 0, waiting: 0 }, `${origin} leaked nothing after a broken stream`);
});

test("agent-team style parallelism: ten child agents share one provider allowance and none is refused", async () => {
  const w = world();
  const shared = w.provider("https://shared.test", { tpm: 9_000 });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ask(w, w.chain([{ origin: shared.origin, model: "m" }]), { text: `child ${i}`, agentId: `child-${i}`, maxTokens: 600 })));
  assert.ok(results.every((result) => /answer from/u.test(result.reply ?? "")), JSON.stringify(results.filter((r) => !r.reply).slice(0, 1)));
  assert.ok(shared.maxUsed <= shared.tpm, "ten logically parallel agents never spent more than the allowance");
  assert.ok(shared.refused429 <= 2, `provider-side 429s: ${shared.refused429}`);
});

test("token gate: a six-round tool run does not resend old tool output, and its total input stays within today's bound", async () => {
  const w = world();
  const big = (round) => `RESULT${round}:` + `line of tool output ${round} `.repeat(900);
  const p = w.provider("https://p.test", {
    behavior: (provider, body) => {
      const rounds = body.messages.filter((message) => message.role === "tool").length;
      if (rounds < 5 && body.tools && body.tool_choice !== "none") return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: `c${rounds}`, type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } });
      return null;
    },
  });
  let round = 0;
  const result = await converse({
    endpoint: w.chain([{ origin: p.origin, model: "m" }]), turns: user("research this"), userMessage: "research this", stream: false, emit: () => {}, allowTasks: false,
    tools: lookupTool, handlers: { lookup: async () => ({ ok: true, label: "Looked it up", content: big(round += 1) }) }, fetcher: w.fetcher, sleep: w.sleep,
  });
  assert.match(result.reply, /answer from/u);
  assert.equal(p.calls, 6, "five tool rounds and the answer: one provider call each");
  const inputChars = p.requests.reduce((sum, body) => sum + JSON.stringify(body.messages).length, 0);
  const firstResultSizes = p.requests.map((body) => body.messages.find((message) => message.role === "tool")?.content.length ?? 0);
  const full = firstResultSizes.filter((size) => size > 5_000).length;
  assert.ok(full <= 1, `the first tool result went out in full ${full} times (${firstResultSizes.join(", ")})`);
  assert.ok(inputChars < 140_000, `total input ${inputChars} characters (measured baseline is far lower; this catches 2x to 10x amplification)`);
});

test("one attempt budget spans retry, same-provider fallback and cross-provider fallback", async () => {
  const w = world();
  const specs = ["a", "b", "c"].map((name) => w.provider(`https://${name}.test`, { behavior: () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }) }));
  const endpoint = w.chain(specs.map((p) => ({ origin: p.origin, model: "m", fallbackModel: "m2", ungoverned: true })));
  const response = await callModel(endpoint, user("hi"), { stream: false, tools: null, fetcher: w.fetcher, sleep: w.sleep, attempts: [{ used: 0, max: 3 }] });
  assert.equal(response.status, 429);
  assert.equal(specs.reduce((sum, p) => sum + p.calls, 0), 3, "three providers with two models each would otherwise take a dozen calls");
  const unbounded = world();
  const more = ["a", "b", "c"].map((name) => unbounded.provider(`https://${name}.test`, { behavior: () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }) }));
  await callModel(unbounded.chain(more.map((p) => ({ origin: p.origin, model: "m", fallbackModel: "m2", ungoverned: true }))), user("hi"), { stream: false, tools: null, fetcher: unbounded.fetcher, sleep: unbounded.sleep });
  assert.ok(more.reduce((sum, p) => sum + p.calls, 0) > 3, "without a budget the same route really does multiply");
});

test("an account with no credit or a model that is gone routes to the next provider; a rejected key is still shown to the owner", async () => {
  for (const [name, status] of [["no credit", 402], ["model gone", 404]]) {
    const w = world();
    const bad = w.provider("https://bad.test", { behavior: () => new Response(JSON.stringify({ error: { message: name } }), { status }) });
    const good = w.provider("https://good.test", {});
    assert.match((await ask(w, w.chain([{ origin: bad.origin, model: "m", ungoverned: true }, { origin: good.origin, model: "g", ungoverned: true }]))).reply, /good\.test/u, name);
  }
  const w = world();
  const key = w.provider("https://key.test", { behavior: () => new Response("invalid api key", { status: 401 }) });
  const good = w.provider("https://good.test", {});
  const result = await ask(w, w.chain([{ origin: key.origin, model: "m", ungoverned: true }, { origin: good.origin, model: "g", ungoverned: true }]));
  assert.ok(result.error && good.calls === 0, "a wrong credential is a setup error, not something to hide behind a fallback");
});

test("concurrent streams on a cold model do not queue behind each other's generation", async () => {
  const w = world();
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const p = w.provider("https://stream.test", {
    behavior: (provider) => {
      if (provider.calls === 2) open();
      const encoder = new TextEncoder();
      let step = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          if (step === 0) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}\n\n`)); step = 1; return; }
          if (provider.calls < 2) await gate;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "llo" } }] })}\n\ndata: [DONE]\n\n`)); controller.close();
        },
      }), { headers: { "content-type": "text/event-stream", "x-ratelimit-limit-tokens": "100000", "x-ratelimit-remaining-tokens": "99000", "x-ratelimit-reset-tokens": "60s" } });
    },
  });
  const results = await Promise.all([ask(w, w.chain([{ origin: p.origin, model: "m" }]), { stream: true }), ask(w, w.chain([{ origin: p.origin, model: "m" }]), { stream: true })]);
  assert.deepEqual(results.map((result) => result.reply), ["hello", "hello"]);
  assert.equal(p.calls, 2);
  assert.ok(w.clock.now < 2_000, `the second stream waited ${w.clock.now}ms for the first one's generation to end`);
});
