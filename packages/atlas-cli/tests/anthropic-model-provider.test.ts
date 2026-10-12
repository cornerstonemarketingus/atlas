import assert from "node:assert/strict";
import test from "node:test";
import { ModelProviderError, type ModelCapabilities, type ModelRequest } from "../src/model/model-provider.js";
import {
  AnthropicModelProvider,
  DEFAULT_ANTHROPIC_MODELS,
} from "../src/infrastructure/anthropic-model-provider.js";

const model: ModelCapabilities = {
  model: "claude-opus-5",
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 128_000,
  supportsTools: true,
  supportsJson: true,
  supportsStreaming: false,
};
const request: ModelRequest = {
  model: "claude-opus-5",
  messages: [
    { role: "system", content: [{ type: "text", text: "You are terse." }] },
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ],
};

const okBody = JSON.stringify({
  id: "msg_1",
  model: "claude-opus-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "hi there" }],
  usage: { input_tokens: 5, output_tokens: 2 },
});

function fakeFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(input, init)) as typeof fetch;
}

test("sends anthropic auth headers and parses a successful response", async () => {
  let observedHeaders: Record<string, string> = {};
  let observedBody: Record<string, unknown> = {};
  const provider = new AnthropicModelProvider({
    apiKey: "test-key",
    models: [model],
    fetchImplementation: fakeFetch((_input, init) => {
      observedHeaders = init?.headers as Record<string, string>;
      observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(okBody, { status: 200, headers: { "content-type": "application/json" } });
    }),
  });

  const result = await provider.complete(request);
  assert.equal(observedHeaders["x-api-key"], "test-key");
  assert.equal(observedHeaders["anthropic-version"], "2023-06-01");
  assert.equal(observedHeaders["authorization"], undefined, "Anthropic uses x-api-key, never a bearer token");
  assert.equal(observedBody["model"], "claude-opus-5");
  assert.equal(observedBody["system"], "You are terse.");
  assert.equal(typeof observedBody["max_tokens"], "number");
  assert.equal(result.providerId, "anthropic");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.message.content[0]?.type, "text");
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
});

test("exposes anthropic metadata and a default model catalogue", () => {
  const provider = new AnthropicModelProvider({ apiKey: "key" });
  assert.equal(provider.metadata.id, "anthropic");
  assert.equal(provider.metadata.displayName, "Anthropic");
  assert.deepEqual(
    provider.metadata.models.map((entry) => entry.model),
    DEFAULT_ANTHROPIC_MODELS.map((entry) => entry.model),
  );
  assert.ok(provider.metadata.models.some((entry) => entry.model === "claude-opus-5"));
});

test("never places the api key in the url, the body, or an error message", async () => {
  const apiKey = "sk-ant-supersecret";
  let observedUrl = "";
  let observedBody = "";
  const provider = new AnthropicModelProvider({
    apiKey,
    models: [model],
    fetchImplementation: fakeFetch((input, init) => {
      observedUrl = String(input);
      observedBody = String(init?.body);
      // A hostile/echoing endpoint reflecting the key back must still not leak it.
      return new Response(JSON.stringify({ error: { message: `bad key ${apiKey}` } }), { status: 400 });
    }),
  });

  await assert.rejects(provider.complete(request), (error: unknown) => {
    assert.ok(error instanceof ModelProviderError);
    assert.ok(!error.message.includes(apiKey), "the api key must never reach an error message");
    assert.ok(error.message.includes("[redacted]"));
    return true;
  });
  assert.ok(!observedUrl.includes(apiKey), "the api key must never reach the URL");
  assert.ok(!observedBody.includes(apiKey), "the api key must never reach the request body");
});

test("rejects an empty api key", () => {
  assert.throws(() => new AnthropicModelProvider({ apiKey: "" }), TypeError);
  assert.throws(() => new AnthropicModelProvider({ apiKey: "   " }), TypeError);
});

test("includes the response body in the error message so failures are debuggable", async () => {
  const provider = new AnthropicModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: fakeFetch(
      () =>
        new Response(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be positive" } }),
          { status: 400 },
        ),
    ),
  });
  await assert.rejects(provider.complete(request), (error: unknown) => {
    assert.ok(error instanceof ModelProviderError);
    assert.equal(error.code, "invalid-request");
    assert.equal(error.retryable, false);
    assert.ok(error.message.includes("HTTP 400"));
    assert.ok(error.message.includes("max_tokens: must be positive"), "the status code alone is ambiguous");
    return true;
  });
});

test("truncates an oversized error body instead of echoing it whole", async () => {
  const provider = new AnthropicModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: fakeFetch(() => new Response("x".repeat(10_000), { status: 400 })),
  });
  await assert.rejects(provider.complete(request), (error: unknown) => {
    assert.ok(error instanceof ModelProviderError);
    assert.ok(error.message.length < 800);
    assert.ok(error.message.endsWith("..."));
    return true;
  });
});

test("classifies http statuses into the provider error taxonomy", async () => {
  const cases: readonly (readonly [number, string, boolean])[] = [
    [401, "authentication", false],
    [403, "authentication", false],
    [400, "invalid-request", false],
    [413, "invalid-request", false],
    [404, "model-unavailable", false],
    [429, "rate-limit", true],
    [500, "provider-failure", true],
    [529, "provider-failure", true],
  ];
  for (const [status, code, retryable] of cases) {
    const provider = new AnthropicModelProvider({
      apiKey: "key",
      models: [model],
      fetchImplementation: fakeFetch(() => new Response("body", { status })),
    });
    await assert.rejects(provider.complete(request), (error: unknown) => {
      assert.ok(error instanceof ModelProviderError, `status ${status}`);
      assert.equal(error.code, code, `status ${status} code`);
      assert.equal(error.retryable, retryable, `status ${status} retryable`);
      assert.equal(error.providerId, "anthropic");
      return true;
    });
  }
});

test("classifies a credit-balance 400 as billing exhaustion, not a generic invalid request", async () => {
  const provider = new AnthropicModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: fakeFetch(() => new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits." } }),
      { status: 400 },
    )),
  });
  await assert.rejects(provider.complete(request), (error: unknown) => {
    assert.ok(error instanceof ModelProviderError);
    assert.equal(error.code, "billing-exhausted");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("rejects malformed JSON and oversized responses", async () => {
  const malformed = new AnthropicModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: fakeFetch(() => new Response("not json", { status: 200 })),
  });
  await assert.rejects(malformed.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "provider-failure" && !error.retryable);

  const oversized = new AnthropicModelProvider({
    apiKey: "key",
    models: [model],
    maxResponseBytes: 16,
    fetchImplementation: fakeFetch(() => new Response(JSON.stringify({ padding: "x".repeat(64) }), { status: 200 })),
  });
  await assert.rejects(oversized.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "provider-failure" && !error.retryable);
});

test("propagates cancellation distinctly from network failure", async () => {
  const controller = new AbortController();
  const cancelled = new AnthropicModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: (async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(cancelled.complete(request, { signal: controller.signal }), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "cancelled" && !error.retryable);

  const networkFailure = new AnthropicModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(networkFailure.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "provider-failure" && error.retryable);
});

test("applies the provider-level default for max_tokens when the request omits it", async () => {
  let observedBody: Record<string, unknown> = {};
  const provider = new AnthropicModelProvider({
    apiKey: "key",
    models: [model],
    defaultMaxOutputTokens: 2_048,
    fetchImplementation: fakeFetch((_input, init) => {
      observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(okBody, { status: 200 });
    }),
  });
  await provider.complete(request);
  assert.equal(observedBody["max_tokens"], 2_048);
});
