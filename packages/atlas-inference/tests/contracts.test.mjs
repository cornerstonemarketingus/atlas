import assert from "node:assert/strict";
import test from "node:test";
import {
  InferenceEvent, LatencyClass, ProviderCapacityState, RateLimitState, RequestState,
  compareRequests, createCheckpoint, createInferenceRequest, eligibility, isTerminal, usageFrom,
} from "../src/index.mjs";

const target = {
  id: "groq/openai/gpt-oss-120b", provider: "groq", origin: "https://api.groq.com", model: "openai/gpt-oss-120b", quotaScope: "groq:org",
  capabilities: { tools: true, json: true, streaming: true, reasoning: true }, contextWindowTokens: 131_072, maxOutputTokens: 32_768, local: false, paid: false,
};
const request = (overrides = {}) => createInferenceRequest({ id: "req-1", taskId: "task-1", role: "lead", estimatedInputTokens: 3_000, maxOutputTokens: 2_048, ...overrides });

test("requests are validated where they are built, with safe defaults", () => {
  const built = request();
  assert.equal(built.latencyClass, LatencyClass.TASK_CRITICAL);
  assert.equal(built.state, RequestState.QUEUED);
  assert.equal(built.priority, 0);
  assert.throws(() => request({ id: "has spaces" }), /idempotency key/u);
  assert.throws(() => request({ taskId: "" }), /taskId/u);
  assert.throws(() => request({ latencyClass: "SOON" }), /latencyClass/u);
  assert.throws(() => request({ maxOutputTokens: -1 }), /non-negative/u);
  assert.throws(() => request({ state: "DONE" }), /state/u);
  assert.deepEqual(JSON.parse(JSON.stringify(built)), built, "survives JSON: queues and handoffs serialize it");
});

test("the queue order is latency class, then priority, then arrival; final answers first", () => {
  const items = [
    { ...request({ id: "batch", latencyClass: "BATCH", priority: 9 }), enqueuedAt: 1 },
    { ...request({ id: "bg", latencyClass: "BACKGROUND" }), enqueuedAt: 2 },
    { ...request({ id: "late", latencyClass: "INTERACTIVE", priority: 1 }), enqueuedAt: 5 },
    { ...request({ id: "synthesis", latencyClass: "INTERACTIVE", priority: 5 }), enqueuedAt: 6 },
    { ...request({ id: "early", latencyClass: "INTERACTIVE", priority: 1 }), enqueuedAt: 3 },
  ];
  assert.deepEqual(items.sort(compareRequests).map((item) => item.id), ["synthesis", "early", "late", "bg", "batch"]);
});

test("terminal states are exactly completed, failed and cancelled; waiting is never terminal", () => {
  assert.equal(isTerminal(RequestState.WAITING_FOR_CAPACITY), false);
  assert.equal(isTerminal(RequestState.WAITING_FOR_TARGET), false);
  assert.ok([RequestState.COMPLETED, RequestState.FAILED, RequestState.CANCELLED].every(isTerminal));
});

test("usage is read from OpenAI and Groq shapes, including cached and reasoning tokens", () => {
  assert.deepEqual(usageFrom({ usage: { prompt_tokens: 5000, completion_tokens: 900, total_tokens: 5900, prompt_tokens_details: { cached_tokens: 3200 }, completion_tokens_details: { reasoning_tokens: 600 } } }),
    { promptTokens: 5000, completionTokens: 900, totalTokens: 5900, reasoningTokens: 600, cachedTokens: 3200 });
  assert.equal(usageFrom({ x_groq: { usage: { prompt_tokens: 10 } } }).promptTokens, 10);
  assert.deepEqual(usageFrom({}), { promptTokens: null, completionTokens: null, totalTokens: null, reasoningTokens: null, cachedTokens: null });
});

test("a checkpoint is bounded and keeps the newest tool results", () => {
  const results = Array.from({ length: 20 }, (_, index) => `result ${index} ${"x".repeat(3_000)}`);
  const checkpoint = createCheckpoint({ taskId: "task-1", objective: "o".repeat(10_000), plan: ["a", "b"], completedSteps: [{ label: "read", ok: true }], relevantToolResults: results, changedFiles: ["auth/session.ts"], validation: { passed: 47, failed: 2 }, failures: ["2 tests fail"], unresolvedItems: ["repair tests"] });
  assert.equal(checkpoint.version, 1);
  assert.ok(checkpoint.objective.length < 4_100);
  assert.ok(checkpoint.relevantToolResults.join("").length <= 16_100);
  assert.match(checkpoint.relevantToolResults.at(-1), /^result 19 /u, "the newest evidence survives trimming");
  assert.deepEqual(checkpoint.validation, { passed: 47, failed: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(checkpoint)), checkpoint);
  assert.throws(() => createCheckpoint({}), /taskId/u);
});

test("eligibility: a request a target can never serve is routed elsewhere, not queued", () => {
  assert.deepEqual(eligibility(target, request()), { eligible: true });
  assert.deepEqual(eligibility({ ...target, capabilities: { ...target.capabilities, tools: false } }, request({ requiredCapabilities: { tools: true } })), { eligible: false, reason: "missing_capability:tools" });
  assert.equal(eligibility(target, request({ maxOutputTokens: 40_000 })).reason, "output_exceeds_model_limit");
  assert.equal(eligibility({ ...target, contextWindowTokens: 4_096 }, request()).reason, "context_exceeds_window");
  // Groq's free tier: a 6,000 TPM organization cannot take 3,000 in + 4,096 out in any minute.
  assert.equal(eligibility(target, request({ maxOutputTokens: 4_096 }), { limitTokens: 6_000 }).reason, "exceeds_per_minute_allowance");
  // A target known to count only input against the limit.
  assert.deepEqual(eligibility(target, request({ maxOutputTokens: 4_096 }), { limitTokens: 6_000, outputCountsTowardLimit: false }), { eligible: true });
  assert.equal(eligibility(target, request(), { limitInputTokens: 2_000 }).reason, "exceeds_per_minute_input_allowance");
  assert.equal(eligibility(target, request(), { limitOutputTokens: 1_000 }).reason, "exceeds_per_minute_output_allowance");
  assert.deepEqual(eligibility(target, request(), { limitTokens: null }), { eligible: true }, "an unknown limit is not a reason to refuse");
});

test("the program's names exist and the earlier name still works", () => {
  assert.equal(RateLimitState, ProviderCapacityState);
  assert.equal(InferenceEvent.EMPTY_RESPONSE, "inference.empty_response");
  assert.equal(Object.keys(InferenceEvent).length, 12);
});
