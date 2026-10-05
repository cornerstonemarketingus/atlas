import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitState, estimateRequestTokens, parseDurationMs, parseRateLimitHeaders, targetKey } from "../src/index.mjs";

const groqHeaders = (overrides = {}) => new Headers({
  "x-ratelimit-limit-requests": "1000",
  "x-ratelimit-limit-tokens": "8000",
  "x-ratelimit-remaining-requests": "998",
  "x-ratelimit-remaining-tokens": "1200",
  "x-ratelimit-reset-requests": "2m59.56s",
  "x-ratelimit-reset-tokens": "7.66s",
  ...overrides,
});

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test("Go durations, as Groq writes them", () => {
  assert.equal(parseDurationMs("7.66s"), 7_660);
  assert.equal(parseDurationMs("340ms"), 340);
  assert.equal(parseDurationMs("2m59.56s"), 179_560);
  assert.equal(parseDurationMs("1h2m3s"), 3_723_000);
  assert.equal(parseDurationMs("soon"), null);
  assert.equal(parseDurationMs(""), null);
});

test("all seven Groq capacity headers are read; missing ones are unknown, not zero", () => {
  const parsed = parseRateLimitHeaders(groqHeaders({ "retry-after": "4" }), 0);
  assert.deepEqual(parsed, {
    limitRequests: 1000, limitTokens: 8000, remainingRequests: 998, remainingTokens: 1200,
    resetRequestsAt: 179_560, resetTokensAt: 7_660, retryAfterAt: 4_000,
  });
  const empty = parseRateLimitHeaders(new Headers(), 0);
  assert.ok(Object.values(empty).every((value) => value === null));
});

test("a target is one model on one endpoint", () => {
  assert.equal(targetKey({ baseUrl: "https://api.groq.com/openai/v1/", model: "openai/gpt-oss-120b" }), "api.groq.com/openai/gpt-oss-120b");
  assert.notEqual(targetKey({ baseUrl: "https://api.groq.com/openai/v1", model: "a" }), targetKey({ baseUrl: "https://api.groq.com/openai/v1", model: "b" }));
});

test("a request that fits what is left goes; one that does not waits for the reset", () => {
  const time = clock();
  const state = new RateLimitState({ now: time.now });
  const key = "groq/m";
  assert.deepEqual(state.check(key, 5_000), { ok: true }, "unknown targets are not blocked");
  state.observe(key, groqHeaders());
  assert.deepEqual(state.check(key, 1_000), { ok: true });
  assert.deepEqual(state.check(key, 5_000), { ok: false, waitMs: 7_660, reason: "tokens_exhausted" });
  time.advance(7_660);
  assert.deepEqual(state.check(key, 5_000), { ok: true }, "after the reset the window is full again");
});

test("a request larger than the whole allowance is never told to wait", () => {
  const state = new RateLimitState({ now: () => 0 });
  state.observe("k", groqHeaders());
  assert.deepEqual(state.check("k", 9_000), { ok: false, waitMs: Number.POSITIVE_INFINITY, reason: "larger_than_allowance" });
});

test("a refusal blocks the target until its stated wait, so nothing is sent into it", () => {
  const time = clock();
  const state = new RateLimitState({ now: time.now });
  state.rateLimited("k", { retryAfterMs: 9_911 });
  assert.deepEqual(state.check("k"), { ok: false, waitMs: 9_911, reason: "rate_limit" });
  time.advance(9_911);
  assert.deepEqual(state.check("k"), { ok: true });
});

test("a daily refusal says so, and a later short refusal cannot shorten it", () => {
  const time = clock();
  const state = new RateLimitState({ now: time.now });
  state.rateLimited("k", { retryAfterMs: 585_600, scope: "daily" });
  state.rateLimited("k", { retryAfterMs: 1_000 });
  assert.deepEqual(state.check("k"), { ok: false, waitMs: 585_600, reason: "daily_limit" });
});

test("a refusal without a stated wait uses the known reset, never zero", () => {
  const time = clock();
  const state = new RateLimitState({ now: time.now });
  state.observe("k", groqHeaders({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "5s" }));
  state.rateLimited("k");
  assert.equal(state.check("k").waitMs, 5_000);
  const bare = new RateLimitState({ now: time.now });
  bare.rateLimited("k");
  assert.equal(bare.check("k").waitMs, 2_000);
});

test("requests in flight count against what is left, so parallel agents do not all go at once", () => {
  const state = new RateLimitState({ now: () => 0 });
  state.observe("k", groqHeaders({ "x-ratelimit-remaining-tokens": "6000" }));
  const first = state.begin("k", 4_000);
  assert.equal(state.check("k", 3_000).ok, false, "4,000 in flight leaves 2,000");
  first();
  first(); // finishing twice is harmless
  assert.equal(state.check("k", 3_000).ok, true);
  assert.equal(state.snapshot("k").inFlight, 0);
});

test("an exhausted request allowance blocks until its own reset", () => {
  const state = new RateLimitState({ now: () => 0 });
  state.observe("k", groqHeaders({ "x-ratelimit-remaining-requests": "0" }));
  assert.deepEqual(state.check("k", 1), { ok: false, waitMs: 179_560, reason: "requests_exhausted" });
});

test("token estimates err high", () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(3_000) }] });
  assert.ok(estimateRequestTokens(body) >= 1_000);
});
