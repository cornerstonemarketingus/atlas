import assert from "node:assert/strict";
import test from "node:test";
import { InferenceErrorKind as K, classifyCompletion, classifyHttpFailure, classifyThrown, describeForPerson, isTransient, recoveryFor } from "../src/index.mjs";

// Real Groq bodies (model and organisation ids replaced).
const GROQ_TPM = JSON.stringify({ error: { message: "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7415, Requested 1906. Please try again in 9.911s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing", type: "tokens", code: "rate_limit_exceeded" } });
const GROQ_TPD = JSON.stringify({ error: { message: "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199100, Requested 2208. Please try again in 9m45.6s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing", type: "tokens", code: "rate_limit_exceeded" } });
const GROQ_413 = JSON.stringify({ error: { message: "Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 9886, please reduce your message size and try again.", type: "tokens", code: "rate_limit_exceeded" } });

test("a Groq per-minute 429 is a rate limit with its stated wait, not a billing failure", () => {
  const result = classifyHttpFailure({ status: 429, body: GROQ_TPM });
  assert.deepEqual(result, { kind: K.RATE_LIMIT, status: 429, retryAfterMs: 9_911, scope: "minute" });
});

test("a Groq daily 429 is marked daily, with its minutes-long wait", () => {
  const result = classifyHttpFailure({ status: 429, body: GROQ_TPD });
  assert.equal(result.kind, K.RATE_LIMIT);
  assert.equal(result.scope, "daily");
  assert.equal(result.retryAfterMs, 585_600);
});

test("retry-after wins over the body's wait", () => {
  assert.equal(classifyHttpFailure({ status: 429, body: GROQ_TPM, headers: new Headers({ "retry-after": "3" }) }).retryAfterMs, 3_000);
  assert.equal(classifyHttpFailure({ status: 429, headers: { "Retry-After": "2" } }).retryAfterMs, 2_000);
});

test("a request larger than the whole per-minute allowance is too large, not a wait", () => {
  const result = classifyHttpFailure({ status: 413, body: GROQ_413 });
  assert.equal(result.kind, K.CONTEXT_TOO_LARGE);
  assert.equal(result.scope, "rate_allowance");
  assert.equal(recoveryFor(result.kind).retrySameTarget, false);
  assert.equal(recoveryFor(result.kind).alternateTarget, true);
});

test("each status maps to the recovery it needs", () => {
  const cases = [
    [{ status: 401 }, K.AUTHENTICATION],
    [{ status: 403 }, K.PERMISSION],
    [{ status: 402 }, K.BILLING],
    [{ status: 429, body: "{\"error\":{\"code\":\"insufficient_quota\"}}" }, K.BILLING],
    [{ status: 404 }, K.MODEL_NOT_FOUND],
    [{ status: 400, body: "The model `llama3-70b-8192` has been decommissioned" }, K.MODEL_NOT_FOUND],
    [{ status: 400, body: "This model's maximum context length is 8192 tokens" }, K.CONTEXT_TOO_LARGE],
    [{ status: 400, body: "tool_use_failed" }, K.UNKNOWN],
    [{ status: 408 }, K.TIMEOUT],
    [{ status: 504 }, K.TIMEOUT],
    [{ status: 503, body: "The service is over capacity" }, K.CAPACITY],
    [{ status: 529 }, K.CAPACITY],
    [{ status: 500 }, K.SERVER_ERROR],
    [{ status: 502 }, K.SERVER_ERROR],
  ];
  for (const [input, kind] of cases) assert.equal(classifyHttpFailure(input).kind, kind, JSON.stringify(input));
});

test("configuration failures are never retried against the same target", () => {
  for (const kind of [K.AUTHENTICATION, K.PERMISSION, K.BILLING, K.MODEL_NOT_FOUND]) {
    assert.equal(recoveryFor(kind).retrySameTarget, false, kind);
    assert.equal(recoveryFor(kind).disableTarget, true, kind);
    assert.equal(isTransient(kind), false, kind);
  }
  for (const kind of [K.RATE_LIMIT, K.CAPACITY, K.SERVER_ERROR, K.TIMEOUT, K.NETWORK]) {
    assert.equal(isTransient(kind), true, kind);
    assert.equal(recoveryFor(kind).cooldownTarget, true, kind);
  }
});

test("the classification never carries the body, which can echo the prompt", () => {
  const result = classifyHttpFailure({ status: 500, body: "SECRET PROMPT sk-live-123" });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|sk-live/u);
});

test("thrown failures: timeout, cancellation, network", () => {
  assert.equal(classifyThrown(Object.assign(new Error("t"), { name: "TimeoutError" })).kind, K.TIMEOUT);
  assert.equal(classifyThrown(new DOMException("a", "AbortError")).kind, K.CANCELLED);
  assert.equal(classifyThrown(new Error("x"), { cancelled: true }).kind, K.CANCELLED);
  assert.equal(classifyThrown(new TypeError("fetch failed")).kind, K.NETWORK);
});

test("an HTTP 200 with nothing in it is EMPTY_MODEL_RESPONSE; words or tool calls are usable", () => {
  assert.equal(classifyCompletion({ payload: { choices: [] } }).kind, K.EMPTY_MODEL_RESPONSE);
  assert.equal(classifyCompletion({ payload: { choices: [] } }).noChoices, true);
  assert.equal(classifyCompletion({ payload: { choices: [{ message: { content: null }, finish_reason: "length" }] } }).finishReason, "length");
  assert.equal(classifyCompletion({ payload: {}, text: "   " }).kind, K.EMPTY_MODEL_RESPONSE);
  assert.equal(classifyCompletion({ payload: null, parsed: false }).kind, K.INVALID_RESPONSE);
  assert.equal(classifyCompletion({ payload: {}, text: "hi" }), null);
  assert.equal(classifyCompletion({ payload: {}, toolCallCount: 1 }), null);
});

test("people see plain words, never status codes or provider names", () => {
  for (const kind of Object.values(K)) {
    const sentence = describeForPerson(kind);
    assert.ok(sentence.length > 0);
    assert.doesNotMatch(sentence, /\b\d{3}\b|groq|TPM|RPM|HTTP/iu, kind);
  }
});
