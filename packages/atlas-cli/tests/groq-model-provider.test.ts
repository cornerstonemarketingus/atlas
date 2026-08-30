import assert from "node:assert/strict";
import test from "node:test";
import { ModelProviderError, type ModelCapabilities, type ModelRequest } from "../src/model/model-provider.js";
import { GroqModelProvider } from "../src/infrastructure/groq-model-provider.js";

const model: ModelCapabilities = { model: "llama-3.3-70b-versatile", contextWindowTokens: 128_000, maxOutputTokens: 8_192, supportsTools: true, supportsJson: true, supportsStreaming: false };
const request: ModelRequest = { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };

function fakeFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(input, init)) as typeof fetch;
}

test("sends a bearer token and parses a successful response", async () => {
  let observedAuth: string | undefined;
  let observedBody: unknown;
  const provider = new GroqModelProvider({
    apiKey: "test-key",
    models: [model],
    fetchImplementation: fakeFetch((_input, init) => {
      observedAuth = (init?.headers as Record<string, string>)["authorization"];
      observedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "resp-1", model: "llama-3.3-70b-versatile",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi there" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  });
  const result = await provider.complete(request);
  assert.equal(observedAuth, "Bearer test-key");
  assert.equal((observedBody as { model: string }).model, "llama-3.3-70b-versatile");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.message.content[0]?.type, "text");
});

test("rejects an empty api key", () => {
  assert.throws(() => new GroqModelProvider({ apiKey: "", models: [model] }), TypeError);
});

test("classifies auth failures as non-retryable", async () => {
  const provider = new GroqModelProvider({
    apiKey: "bad-key",
    models: [model],
    fetchImplementation: fakeFetch(() => new Response("unauthorized", { status: 401 })),
  });
  await assert.rejects(provider.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "authentication" && !error.retryable);
});

test("classifies rate limits and server errors as retryable", async () => {
  const rateLimited = new GroqModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: fakeFetch(() => new Response("slow down", { status: 429 })),
  });
  await assert.rejects(rateLimited.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "rate-limit" && error.retryable);

  const serverError = new GroqModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: fakeFetch(() => new Response("oops", { status: 503 })),
  });
  await assert.rejects(serverError.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.retryable);
});

test("rejects malformed JSON and oversized responses", async () => {
  const malformed = new GroqModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: fakeFetch(() => new Response("not json", { status: 200 })),
  });
  await assert.rejects(malformed.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "provider-failure");

  const oversized = new GroqModelProvider({
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
  const provider = new GroqModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: (async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(provider.complete(request, { signal: controller.signal }), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "cancelled" && !error.retryable);
});
