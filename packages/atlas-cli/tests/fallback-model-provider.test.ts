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

test("does not fall back on authentication failures", async () => {
    const seen: ModelRequest[] = [];
    const first = provider("one", "primary", new ModelProviderError({ message: "bad key", code: "authentication", providerId: "one", retryable: false }), seen);
    const second = provider("two", "backup", response("two", "backup"), seen);
    await assert.rejects(new FallbackModelProvider([{ provider: first, model: "primary" }, { provider: second, model: "backup" }]).complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "authentication");
    assert.equal(seen.length, 1);
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
