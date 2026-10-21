import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { ModelProviderError, type ModelProvider, type ModelProviderMetadata, type ModelResponse } from "../src/model/model-provider.js";
import { RetryingModelProvider } from "../src/infrastructure/retrying-model-provider.js";

const metadata: ModelProviderMetadata = {
  id: "stub", displayName: "Stub",
  models: [{ model: "test", contextWindowTokens: 100, maxOutputTokens: 50, supportsTools: false, supportsJson: false, supportsStreaming: false }],
};

function response(): ModelResponse {
  return {
    id: "response", providerId: "stub", model: "test",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

class ScriptedProvider implements ModelProvider {
  public readonly metadata = metadata;
  public callCount = 0;
  public constructor(private readonly script: readonly (ModelProviderError | ModelResponse)[]) {}
  public async complete(): Promise<ModelResponse> {
    const next = this.script[this.callCount];
    this.callCount += 1;
    if (next === undefined) throw new Error("Scripted provider ran out of responses.");
    if (next instanceof ModelProviderError) throw next;
    return next;
  }
}

function rateLimitError(message = "Groq endpoint returned HTTP 429: rate limited"): ModelProviderError {
  return new ModelProviderError({ message, code: "rate-limit", providerId: "stub", retryable: true });
}

function authError(): ModelProviderError {
  return new ModelProviderError({ message: "Groq endpoint returned HTTP 401", code: "authentication", providerId: "stub", retryable: false });
}

function recordingSleep(): { sleep: (delayMs: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (delayMs: number) => { delays.push(delayMs); } };
}

test("returns the first successful response without retrying", async () => {
  const inner = new ScriptedProvider([response()]);
  const { sleep, delays } = recordingSleep();
  const provider = new RetryingModelProvider(inner, { sleep });

  const result = await provider.complete({ model: "test", messages: [] });

  assert.equal(result.id, "response");
  assert.equal(inner.callCount, 1);
  assert.deepEqual(delays, []);
});

test("retries a retryable error and succeeds, honoring the provider's suggested delay", async () => {
  const inner = new ScriptedProvider([rateLimitError("Groq endpoint returned HTTP 429: Please try again in 21.645s."), response()]);
  const { sleep, delays } = recordingSleep();
  const provider = new RetryingModelProvider(inner, { sleep });

  const result = await provider.complete({ model: "test", messages: [] });

  assert.equal(result.id, "response");
  assert.equal(inner.callCount, 2);
  assert.deepEqual(delays, [21_645]);
});

test("falls back to exponential backoff when no delay is suggested", async () => {
  const inner = new ScriptedProvider([rateLimitError("no suggestion here"), rateLimitError("no suggestion here"), response()]);
  const { sleep, delays } = recordingSleep();
  const provider = new RetryingModelProvider(inner, { sleep, maximumAttempts: 3, baseDelayMs: 1_000 });

  const result = await provider.complete({ model: "test", messages: [] });

  assert.equal(result.id, "response");
  assert.deepEqual(delays, [1_000, 2_000]);
});

test("does not retry a non-retryable error", async () => {
  const inner = new ScriptedProvider([authError()]);
  const { sleep, delays } = recordingSleep();
  const provider = new RetryingModelProvider(inner, { sleep });

  await assert.rejects(provider.complete({ model: "test", messages: [] }), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "authentication");
  assert.equal(inner.callCount, 1);
  assert.deepEqual(delays, []);
});

test("gives up and rethrows once maximumAttempts is exhausted", async () => {
  const inner = new ScriptedProvider([rateLimitError(), rateLimitError()]);
  const { sleep } = recordingSleep();
  const provider = new RetryingModelProvider(inner, { sleep, maximumAttempts: 2, baseDelayMs: 10 });

  await assert.rejects(provider.complete({ model: "test", messages: [] }), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "rate-limit");
  assert.equal(inner.callCount, 2);
});

test("caps exponential backoff at maximumDelayMs", async () => {
  const inner = new ScriptedProvider([rateLimitError("no suggestion"), rateLimitError("no suggestion"), response()]);
  const { sleep, delays } = recordingSleep();
  const provider = new RetryingModelProvider(inner, { sleep, baseDelayMs: 4_000, maximumDelayMs: 5_000 });

  await provider.complete({ model: "test", messages: [] });

  assert.deepEqual(delays, [4_000, 5_000]);
});

test("raises at once when the provider's wait exceeds maximumDelayMs instead of retrying into it", async () => {
  const inner = new ScriptedProvider([rateLimitError("Please try again in 999s."), response()]);
  const { sleep, delays } = recordingSleep();
  const provider = new RetryingModelProvider(inner, { sleep, maximumDelayMs: 5_000 });

  await assert.rejects(provider.complete({ model: "test", messages: [] }), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "rate-limit");
  assert.equal(inner.callCount, 1);
  assert.deepEqual(delays, []);
});

test("understands Groq's minute and millisecond waits", async () => {
  const inner = new ScriptedProvider([
    rateLimitError("Please try again in 1m2.5s."),
    rateLimitError("Please try again in 340ms."),
    response(),
  ]);
  const { sleep, delays } = recordingSleep();
  const provider = new RetryingModelProvider(inner, { sleep, maximumDelayMs: 120_000 });

  await provider.complete({ model: "test", messages: [] });

  assert.deepEqual(delays, [62_500, 340]);
});

test("prefers the wait carried on the error over one in its message", async () => {
  const error = new ModelProviderError({
    message: "HTTP 429: Please try again in 9s.", code: "rate-limit", providerId: "stub", retryable: true, retryAfterMs: 3_000,
  });
  const inner = new ScriptedProvider([error, response()]);
  const { sleep, delays } = recordingSleep();
  const provider = new RetryingModelProvider(inner, { sleep });

  await provider.complete({ model: "test", messages: [] });

  assert.deepEqual(delays, [3_000]);
});

test("rejects an out-of-range maximumAttempts", () => {
  assert.throws(() => new RetryingModelProvider(new ScriptedProvider([response()]), { maximumAttempts: 0 }), RangeError);
  assert.throws(() => new RetryingModelProvider(new ScriptedProvider([response()]), { maximumAttempts: 11 }), RangeError);
});

const cancelled = (error: unknown) => error instanceof ModelProviderError
  && error.code === "cancelled" && !error.retryable;

test("an already cancelled request never invokes the provider", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private cancellation reason"));
  const inner = new ScriptedProvider([response()]);
  await assert.rejects(new RetryingModelProvider(inner).complete(
    { model: "test", messages: [] }, { signal: controller.signal }), cancelled);
  assert.equal(inner.callCount, 0);
});

test("completed default backoffs remove their abort listeners", async () => {
  const controller = new AbortController();
  const inner = new ScriptedProvider([rateLimitError(), response()]);
  const provider = new RetryingModelProvider(inner, { baseDelayMs: 1 });
  await provider.complete({ model: "test", messages: [] }, { signal: controller.signal });
  assert.equal(inner.callCount, 2);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("cancellation during backoff prevents another real HTTP attempt even if sleep resolves", async (t) => {
  let requests = 0;
  const server = createServer((_request, reply) => { requests++; reply.writeHead(503); reply.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const inner: ModelProvider = {
    metadata,
    async complete() {
      // Deliberately no signal handling: the retry boundary itself must stop
      // dispatch, independently of an adapter's cancellation implementation.
      const result = await fetch(`http://127.0.0.1:${address.port}`);
      await result.arrayBuffer();
      throw rateLimitError();
    },
  };
  let sleeps = 0;
  const provider = new RetryingModelProvider(inner, {
    sleep: async () => { sleeps++; controller.abort(); },
  });
  await assert.rejects(provider.complete({ model: "test", messages: [] }, { signal: controller.signal }), cancelled);
  assert.equal(requests, 1);
  assert.equal(sleeps, 1);
});

test("a cancelled last-attempt failure is reported as cancellation", async () => {
  const controller = new AbortController();
  const inner: ModelProvider = { metadata, async complete() { controller.abort(); throw rateLimitError(); } };
  await assert.rejects(new RetryingModelProvider(inner, { maximumAttempts: 1 }).complete(
    { model: "test", messages: [] }, { signal: controller.signal }), cancelled);
});

test("a late provider success cannot complete a cancelled request", async () => {
  const controller = new AbortController();
  const inner: ModelProvider = { metadata, async complete() { controller.abort(); return response(); } };
  await assert.rejects(new RetryingModelProvider(inner).complete(
    { model: "test", messages: [] }, { signal: controller.signal }), cancelled);
});
