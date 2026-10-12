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

test("classifies a billing-exhausted 429 separately from a transient rate limit", async () => {
  const body = JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" } });
  const provider = new GroqModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: fakeFetch(() => new Response(body, { status: 429 })),
  });
  await assert.rejects(provider.complete(request), (error: unknown) => {
    assert.ok(error instanceof ModelProviderError);
    assert.equal(error.code, "billing-exhausted");
    assert.equal(error.retryable, false);
    assert.equal(error.retryAfterMs, undefined, "billing exhaustion never suggests a wait");
    return true;
  });
});

test("does not mistake Groq's daily-quota wording for billing exhaustion", async () => {
  const body = JSON.stringify({ error: { message: "Rate limit reached for model on requests per day (RPD): Limit 1000, Used 1000. Please try again in 8h32m.", code: "rate_limit_exceeded" } });
  const provider = new GroqModelProvider({
    apiKey: "key",
    models: [model],
    fetchImplementation: fakeFetch(() => new Response(body, { status: 429 })),
  });
  await assert.rejects(provider.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "rate-limit" && error.retryable);
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

// The payload below is the real body Groq returned on 2026-09-10, when the
// nightly self-improvement agent called "repo.search" instead of
// "repository.search" and lost the entire run to a 400.
function toolUseFailed(failedGeneration: string): Response {
  return new Response(JSON.stringify({
    error: {
      message: `Tool call validation failed: attempted to call tool 'repo.search' which was not in request.tools`,
      type: "invalid_request_error",
      code: "tool_use_failed",
      failed_generation: failedGeneration,
    },
  }), { status: 400, headers: { "content-type": "application/json" } });
}

function providerReturning(response: Response): GroqModelProvider {
  return new GroqModelProvider({ apiKey: "test-key", models: [model], fetchImplementation: fakeFetch(() => response) });
}

test("returns a tool call Groq rejected instead of failing the session", async () => {
  // Groq validates tool calls server-side and answers an unadvertised name
  // with a 400 rather than returning the call. Raising here ends the run over
  // a mistake the agent recovers from on every other provider.
  const provider = providerReturning(toolUseFailed(
    JSON.stringify({ name: "repo.search", arguments: { path: "src", query: "safe file read", maxResults: 20 } }),
  ));

  const result = await provider.complete(request);
  assert.equal(result.finishReason, "tool-calls");
  const [call] = result.message.content;
  assert.equal(call?.type, "tool-call");
  assert.equal(call?.type === "tool-call" ? call.name : undefined, "repo.search");
  // Validated arguments come back null-prototype; spread to compare by value.
  assert.deepEqual(
    { ...(call?.type === "tool-call" ? call.arguments : undefined) },
    { path: "src", query: "safe file read", maxResults: 20 },
  );
});

test("reports zero usage for a rejected generation rather than inventing one", async () => {
  // Groq bills nothing for a generation it refused and reports no usage with
  // it. A fabricated number would corrupt the session's token accounting.
  const provider = providerReturning(toolUseFailed(JSON.stringify({ name: "repo.search", arguments: {} })));
  const result = await provider.complete(request);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

test("treats a rejected call with no arguments as a call with no arguments", async () => {
  const provider = providerReturning(toolUseFailed(JSON.stringify({ name: "repository.symbols" })));
  const result = await provider.complete(request);
  const [call] = result.message.content;
  assert.deepEqual({ ...(call?.type === "tool-call" ? call.arguments : undefined) }, {});
});

test("still raises a 400 that is not a rejected tool call", async () => {
  const provider = providerReturning(new Response(
    JSON.stringify({ error: { message: "model does not exist", code: "model_not_found" } }),
    { status: 400 },
  ));
  await assert.rejects(provider.complete(request), (error: unknown) => {
    assert.ok(error instanceof ModelProviderError);
    assert.match(error.message, /model does not exist/u);
    return true;
  });
});

test("still raises when the rejected generation cannot be read as a tool call", async () => {
  // Recovery reconstructs a real call; it must never guess. Anything
  // unparseable has to surface as the error it is.
  for (const generation of ["not json at all", JSON.stringify({ arguments: {} }), JSON.stringify({ name: "" })]) {
    const provider = providerReturning(toolUseFailed(generation));
    await assert.rejects(provider.complete(request), ModelProviderError, generation);
  }
});

function okResponse(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({
    id: "resp", model: "llama-3.3-70b-versatile",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

test("carries the wait a 429 names so the retry does not guess", async () => {
  // The body format Groq uses for token-per-minute limits.
  const body = JSON.stringify({ error: { message: "Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 7400, Requested 1900. Please try again in 9.75s.", code: "rate_limit_exceeded" } });
  const fromBody = providerReturning(new Response(body, { status: 429 }));
  await assert.rejects(fromBody.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "rate-limit" && error.retryAfterMs === 9_750);

  const fromHeader = providerReturning(new Response(body, { status: 429, headers: { "retry-after": "12" } }));
  await assert.rejects(fromHeader.complete(request), (error: unknown) =>
    error instanceof ModelProviderError && error.retryAfterMs === 12_000);
});

test("waits for the token window to refill before a request that cannot fit in it", async () => {
  let clock = 1_000;
  const delays: number[] = [];
  const responses = [
    okResponse({ "x-ratelimit-remaining-tokens": "3", "x-ratelimit-reset-tokens": "7.5s" }),
    okResponse({ "x-ratelimit-remaining-tokens": "7000", "x-ratelimit-reset-tokens": "1s" }),
    okResponse(),
  ];
  const provider = new GroqModelProvider({
    apiKey: "key",
    models: [model],
    now: () => clock,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
    fetchImplementation: fakeFetch(() => responses.shift()!),
  });

  await provider.complete(request);
  clock += 500;
  await provider.complete(request); // 3 tokens left: wait out the rest of the 7.5s window
  await provider.complete(request); // 7,000 left: plenty, no wait
  assert.deepEqual(delays, [7_000]);
});

test("does not pace on a reset longer than a minute, or when pacing is off", async () => {
  const delays: number[] = [];
  const make = (reset: string, paceRequests: boolean) => {
    const responses = [okResponse({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": reset }), okResponse()];
    return new GroqModelProvider({
      apiKey: "key", models: [model], paceRequests,
      sleep: async (ms) => { delays.push(ms); },
      fetchImplementation: fakeFetch(() => responses.shift()!),
    });
  };
  const daily = make("2h3m", true);
  await daily.complete(request);
  await daily.complete(request);
  const off = make("5s", false);
  await off.complete(request);
  await off.complete(request);
  assert.deepEqual(delays, []);
});

test("a pacing wait honours cancellation", async () => {
  const controller = new AbortController();
  const responses = [okResponse({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "30s" }), okResponse()];
  const provider = new GroqModelProvider({
    apiKey: "key", models: [model],
    sleep: async () => { throw new DOMException("aborted", "AbortError"); },
    fetchImplementation: fakeFetch(() => responses.shift()!),
  });
  await provider.complete(request);
  controller.abort();
  await assert.rejects(provider.complete(request, { signal: controller.signal }), (error: unknown) =>
    error instanceof ModelProviderError && error.code === "cancelled");
});
