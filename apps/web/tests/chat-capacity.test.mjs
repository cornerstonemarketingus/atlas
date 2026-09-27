import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitState } from "../../../packages/atlas-inference/src/index.mjs";
import { callModel, converse } from "../app/api/chat/agent-loop.mjs";

// Atlas reads what providers say about their capacity and stops sending
// requests it already knows will be refused.

const endpoint = { baseUrl: "https://model.test/v1", apiKey: "k", model: "big", fallbackModel: "small" };
const ok = (headers = {}) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json", ...headers } });
const limited = (seconds) => new Response(JSON.stringify({ error: { message: `Rate limit reached on tokens per minute (TPM). Please try again in ${seconds}s.` } }), { status: 429 });

function harness() {
  let now = 1_000_000;
  const capacity = new RateLimitState({ now: () => now });
  const waits = [];
  const sent = [];
  const replies = [];
  const fetcher = async (_url, init) => {
    sent.push(JSON.parse(init.body).model);
    const next = replies.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  };
  const sleep = async (ms) => { waits.push(ms); now += ms; };
  return { capacity, waits, sent, replies, fetcher, sleep, advance: (ms) => { now += ms; } };
}

test("a model reported exhausted is skipped for the fallback without spending a request on it", async () => {
  const h = harness();
  h.replies.push(() => ok({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "45s", "x-ratelimit-limit-tokens": "8000" }), () => ok());
  const options = { stream: false, tools: null, fetcher: h.fetcher, sleep: h.sleep, capacity: h.capacity };
  await callModel(endpoint, [{ role: "user", content: "one" }], options);
  const second = await callModel(endpoint, [{ role: "user", content: "two" }], options);
  assert.equal(second.status, 200);
  assert.deepEqual(h.sent, ["big", "small"]);
  assert.deepEqual(h.waits, []);
});

test("a short known wait is waited out, then the same model is used", async () => {
  const h = harness();
  h.replies.push(() => ok({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "1.5s" }), () => ok());
  const options = { stream: false, tools: null, fetcher: h.fetcher, sleep: h.sleep, capacity: h.capacity };
  await callModel(endpoint, [{ role: "user", content: "one" }], options);
  await callModel(endpoint, [{ role: "user", content: "two" }], options);
  assert.deepEqual(h.sent, ["big", "big"]);
  assert.deepEqual(h.waits, [1_500]);
});

test("one agent's 429 spares every other agent the same refusal", async () => {
  const h = harness();
  h.replies.push(() => limited(30), () => ok(), () => ok());
  const options = { stream: false, tools: null, fetcher: h.fetcher, sleep: h.sleep, capacity: h.capacity };
  // Agent A is refused (30s is longer than the in-call wait), falls back.
  await callModel(endpoint, [{ role: "user", content: "a" }], options);
  // Agent B, moments later, does not try the refusing model at all.
  await callModel(endpoint, [{ role: "user", content: "b" }], options);
  assert.deepEqual(h.sent, ["big", "small", "small"]);
});

test("when every model is known to be refusing, nothing is sent and the person gets plain words", async () => {
  const h = harness();
  h.capacity.rateLimited("model.test/big", { retryAfterMs: 90_000 });
  h.capacity.rateLimited("model.test/small", { retryAfterMs: 90_000 });
  const outcome = await converse({
    endpoint, turns: [{ role: "user", content: "hi" }], toolContext: { environment: {} }, userMessage: "hi",
    stream: false, emit: () => {}, fetcher: h.fetcher, sleep: h.sleep, capacity: h.capacity, tools: [],
  });
  assert.deepEqual(h.sent, []);
  assert.equal(outcome.status, 429);
  assert.equal(outcome.kind, "RATE_LIMIT");
  assert.equal(outcome.error, "Model capacity is temporarily full. Ask again in about 90 seconds.");
});

test("a known reset shorter than the reply's wait budget is waited out instead of refused", async () => {
  const h = harness();
  h.capacity.rateLimited("model.test/big", { retryAfterMs: 20_000 });
  h.capacity.rateLimited("model.test/small", { retryAfterMs: 20_000 });
  h.replies.push(() => ok());
  const outcome = await converse({
    endpoint, turns: [{ role: "user", content: "hi" }], toolContext: { environment: {} }, userMessage: "hi",
    stream: false, emit: () => {}, fetcher: h.fetcher, sleep: h.sleep, capacity: h.capacity, tools: [],
  });
  assert.equal(outcome.reply, "ok");
  assert.deepEqual(h.sent, ["big"]);
  assert.deepEqual(h.waits, [20_000]);
});

test("a 401 is configuration: one request, a plain message, no loop", async () => {
  const h = harness();
  h.replies.push(() => new Response("", { status: 401 }));
  const outcome = await converse({
    endpoint, turns: [{ role: "user", content: "hi" }], toolContext: { environment: {} }, userMessage: "hi",
    stream: false, emit: () => {}, fetcher: h.fetcher, sleep: h.sleep, capacity: h.capacity, tools: [],
  });
  assert.deepEqual(h.sent, ["big"]);
  assert.equal(outcome.kind, "AUTHENTICATION");
  assert.match(outcome.error, /key was rejected/u);
});
