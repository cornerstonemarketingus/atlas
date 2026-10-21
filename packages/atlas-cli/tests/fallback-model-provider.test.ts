import assert from "node:assert/strict";
import test from "node:test";
import { FallbackModelProvider } from "../src/infrastructure/fallback-model-provider.js";
import { RetryingModelProvider } from "../src/infrastructure/retrying-model-provider.js";
import { ModelProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from "../src/model/model-provider.js";

const request: ModelRequest = { model: "primary", messages: [], maxOutputTokens: 100 };
const response = (providerId: string, model: string): ModelResponse => ({ id: "r", providerId, model, message: { role: "assistant", content: [] }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
function provider(id: string, model: string, result: ModelResponse | Error, seen: ModelRequest[]): ModelProvider {
  return { metadata: { id, displayName: id, models: [{ model, contextWindowTokens: 1000, maxOutputTokens: 50, supportsTools: true, supportsJson: true, supportsStreaming: false }] }, async complete(value) { seen.push(value); if (result instanceof Error) throw result; return result; } };
}

test("uses the next explicit route after an exhausted transient failure", async () => {
    const seen: ModelRequest[] = [];
    const first = provider("one", "primary", new ModelProviderError({ message: "capacity exhausted", code: "provider-failure", providerId: "one", retryable: true }), seen);
    const second = provider("two", "backup", response("two", "backup"), seen);
    const result = await new FallbackModelProvider([{ provider: first, model: "primary" }, { provider: second, model: "backup" }]).complete(request);
    assert.equal(result.model, "backup");
    assert.deepEqual(seen.map((item) => item.model), ["primary", "backup"]);
    assert.equal(seen[1]?.maxOutputTokens, 50);
});

test("a rejected key on one route moves to the next; a malformed request does not", async () => {
    const seen: ModelRequest[] = [];
    const first = provider("one", "primary", new ModelProviderError({ message: "bad key", code: "authentication", providerId: "one", retryable: false }), seen);
    const second = provider("two", "backup", response("two", "backup"), seen);
    const result = await new FallbackModelProvider([{ provider: first, model: "primary" }, { provider: second, model: "backup" }]).complete(request);
    assert.equal(result.model, "backup");
    const malformed: ModelRequest[] = [];
    const bad = provider("one", "primary", new ModelProviderError({ message: "bad request", code: "invalid-request", providerId: "one", retryable: false }), malformed);
    await assert.rejects(new FallbackModelProvider([{ provider: bad, model: "primary" }, { provider: provider("two", "backup", response("two", "backup"), malformed), model: "backup" }]).complete(request),
      (error: unknown) => error instanceof ModelProviderError && error.code === "invalid-request");
    assert.equal(malformed.length, 1);
});

test("a daily quota moves straight to the next route instead of sleeping through retries", async () => {
    const seen: ModelRequest[] = [];
    const delays: number[] = [];
    const daily = new ModelProviderError({ message: "Groq endpoint returned HTTP 429: tokens per day (TPD). Please try again in 7m12.5s.", code: "rate-limit", providerId: "one", retryable: true });
    const first = new RetryingModelProvider(provider("one", "primary", daily, seen), { sleep: async (ms) => { delays.push(ms); } });
    const second = provider("two", "backup", response("two", "backup"), seen);
    const result = await new FallbackModelProvider([{ provider: first, model: "primary" }, { provider: second, model: "backup" }]).complete(request);
    assert.equal(result.model, "backup");
    assert.deepEqual(seen.map((item) => item.model), ["primary", "backup"]);
    assert.deepEqual(delays, []);
});

const limited = (id: string, retryAfterMs?: number) => new ModelProviderError({ message: "slow down", code: "rate-limit", providerId: id, retryable: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });

test("when every route is out of capacity, the chain waits for the soonest reset and carries on", async () => {
    const seen: ModelRequest[] = [];
    const delays: number[] = [];
    let calls = 0;
    const flaky: ModelProvider = { metadata: provider("one", "primary", response("one", "primary"), seen).metadata,
      async complete(value) { seen.push(value); calls += 1; if (calls === 1) throw limited("one", 40_000); return response("one", "primary"); } };
    const other = provider("two", "backup", limited("two", 20_000), seen);
    const chain = new FallbackModelProvider([{ provider: flaky, model: "primary" }, { provider: other, model: "backup" }], { capacityWaitMs: 60_000, sleep: async (ms) => { delays.push(ms); } });
    const result = await chain.complete(request);
    assert.equal(result.model, "primary");
    assert.deepEqual(delays, [20_000], "the soonest stated reset across routes");
    assert.deepEqual(seen.map((item) => item.model), ["primary", "backup", "primary"]);
});

test("the wait budget is shared by the whole run, and a reset beyond it fails at once with when it ends", async () => {
    const delays: number[] = [];
    const chain = new FallbackModelProvider([{ provider: provider("one", "primary", limited("one", 30_000), []), model: "primary" }], { capacityWaitMs: 70_000, sleep: async (ms) => { delays.push(ms); } });
    await assert.rejects(chain.complete(request), (error: unknown) => error instanceof ModelProviderError && /out of capacity; the soonest stated reset is in about 1 min/u.test(error.message));
    assert.deepEqual(delays, [30_000, 30_000], "two waits fit the budget, the third does not");
    await assert.rejects(chain.complete(request));
    assert.deepEqual(delays, [30_000, 30_000], "a later request in the same run has no budget left");
    const daily = new FallbackModelProvider([{ provider: provider("one", "primary", limited("one", 6 * 3_600_000), []), model: "primary" }], { capacityWaitMs: 300_000, sleep: async (ms) => { delays.push(ms); } });
    await assert.rejects(daily.complete(request), (error: unknown) => error instanceof ModelProviderError && /about 360 min/u.test(error.message));
});

test("a route that is gone, not just busy, means no waiting", async () => {
    const delays: number[] = [];
    const gone = new ModelProviderError({ message: "no such model", code: "model-unavailable", providerId: "two", retryable: false });
    const chain = new FallbackModelProvider([{ provider: provider("one", "primary", limited("one", 1_000), []), model: "primary" }, { provider: provider("two", "backup", gone, []), model: "backup" }], { capacityWaitMs: 60_000, sleep: async (ms) => { delays.push(ms); } });
    await assert.rejects(chain.complete(request));
    assert.deepEqual(delays, []);
});

test("waiting for capacity honours cancellation", async () => {
    const controller = new AbortController();
    const chain = new FallbackModelProvider([{ provider: provider("one", "primary", limited("one", 50_000), []), model: "primary" }], { capacityWaitMs: 60_000 });
    const pending = chain.complete(request, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof ModelProviderError && error.code === "cancelled");
});
