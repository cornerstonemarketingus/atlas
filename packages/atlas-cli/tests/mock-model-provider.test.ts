import assert from "node:assert/strict";
import { test } from "node:test";

import { MockModelProvider } from "../src/infrastructure/mock-model-provider.js";
import {
  ModelProviderError,
  type ModelProvider,
  type ModelProviderMetadata,
  type ModelRequest,
  type ModelResponse,
} from "../src/model/model-provider.js";

const metadata: ModelProviderMetadata = {
  id: "mock",
  displayName: "Deterministic mock",
  models: [
    {
      model: "atlas-test",
      contextWindowTokens: 8_192,
      maxOutputTokens: 1_024,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: false,
    },
  ],
};

const response: ModelResponse = {
  id: "response-1",
  providerId: "mock",
  model: "atlas-test",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Inspect the repository first." }],
  },
  finishReason: "stop",
  usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
};

const request: ModelRequest = {
  model: "atlas-test",
  messages: [
    { role: "system", content: [{ type: "text", text: "Be safe." }] },
    { role: "user", content: [{ type: "text", text: "Plan a change." }] },
  ],
  tools: [
    {
      name: "read_file",
      description: "Read a repository file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
};

test("mock provider satisfies the provider-neutral contract deterministically", async () => {
  const provider: ModelProvider = new MockModelProvider({
    metadata,
    responses: [response],
  });

  const actual = await provider.complete(request);

  assert.deepEqual(actual, response);
  assert.equal(provider.metadata.id, "mock");
});

test("mock provider records an isolated request snapshot", async () => {
  const provider = new MockModelProvider({ metadata, responses: [response] });

  await provider.complete(request);
  assert.deepEqual(provider.requests, [request]);
  assert.notEqual(provider.requests[0], request);
});

test("mock provider reports unsupported models with a provider-neutral error", async () => {
  const provider = new MockModelProvider({ metadata, responses: [response] });

  await assert.rejects(
    provider.complete({ ...request, model: "unknown" }),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.code === "model-unavailable" &&
      error.providerId === "mock" &&
      error.retryable === false,
  );
  assert.equal(provider.requests.length, 0);
});

test("mock provider honors cancellation without consuming a response", async () => {
  const provider = new MockModelProvider({ metadata, responses: [response] });
  const controller = new AbortController();
  controller.abort("test cancellation");

  await assert.rejects(
    provider.complete(request, { signal: controller.signal }),
    (error: unknown) =>
      error instanceof ModelProviderError && error.code === "cancelled",
  );

  assert.equal(provider.requests.length, 0);
  assert.deepEqual(await provider.complete(request), response);
});

test("mock provider fails explicitly when its configured queue is exhausted", async () => {
  const provider = new MockModelProvider({ metadata, responses: [] });

  await assert.rejects(
    provider.complete(request),
    (error: unknown) =>
      error instanceof ModelProviderError && error.code === "provider-failure",
  );
});
