import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelValidationError,
  validateModelProviderMetadata,
  validateModelRequest,
  validateModelResponse,
} from "../src/model/model-contract-validation.js";

test("validates and returns a complete model request", () => {
  const request = validateModelRequest({
    model: "atlas-test",
    messages: [
      { role: "system", content: [{ type: "text", text: "Be safe." }] },
      { role: "user", content: [{ type: "json", value: { task: "inspect" } }] },
      { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }] },
      { role: "tool", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "ok" }] },
    ],
    tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
    temperature: 0.2,
    maxOutputTokens: 512,
    responseFormat: "json",
  });
  assert.equal(request.messages.length, 4);
  assert.equal(request.tools?.[0]?.name, "read");
});

test("rejects malformed request content with a typed path and code", () => {
  assert.throws(
    () => validateModelRequest({ model: "x", messages: [{ role: "assistant", content: [{ type: "json", value: {} }] }] }),
    (error: unknown) => error instanceof ModelValidationError
      && error.path === "$request.messages[0].content[0].type"
      && error.code === "invalid-value",
  );
});

test("rejects unknown fields and non-finite JSON values", () => {
  assert.throws(
    () => validateModelRequest({ model: "x", messages: [], unsafe: true }),
    (error: unknown) => error instanceof ModelValidationError && error.code === "unknown-field",
  );
  assert.throws(
    () => validateModelRequest({ model: "x", messages: [{ role: "user", content: [{ type: "json", value: Number.NaN }] }] }),
    (error: unknown) => error instanceof ModelValidationError && error.path.endsWith(".value"),
  );
});

test("rejects excessive arrays and string fields", () => {
  assert.throws(
    () => validateModelRequest({ model: "x", messages: Array.from({ length: 1_001 }, () => ({ role: "user", content: [] })) }),
    (error: unknown) => error instanceof ModelValidationError && error.code === "limit-exceeded",
  );
  assert.throws(
    () => validateModelRequest({ model: "x".repeat(257), messages: [] }),
    (error: unknown) => error instanceof ModelValidationError && error.path === "$request.model",
  );
});

test("validates response usage and rejects inconsistent totals", () => {
  const valid = {
    id: "response-1", providerId: "mock", model: "atlas-test",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    finishReason: "stop", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2, estimatedCostUsd: 0 },
  };
  assert.equal(validateModelResponse(valid).usage.totalTokens, 14);
  assert.throws(
    () => validateModelResponse({ ...valid, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 15 } }),
    (error: unknown) => error instanceof ModelValidationError
      && error.path === "$response.usage.totalTokens"
      && error.code === "invalid-value",
  );
});

test("validates provider metadata and capability relationships", () => {
  const valid = {
    id: "mock", displayName: "Mock Provider", models: [{
      model: "atlas-test", contextWindowTokens: 8_192, maxOutputTokens: 1_024,
      supportsTools: true, supportsJson: true, supportsStreaming: false,
    }],
  };
  assert.equal(validateModelProviderMetadata(valid).models.length, 1);
  assert.throws(
    () => validateModelProviderMetadata({ ...valid, models: [{ ...valid.models[0], maxOutputTokens: 9_000 }] }),
    (error: unknown) => error instanceof ModelValidationError
      && error.path === "$metadata.models[0].maxOutputTokens",
  );
  assert.throws(
    () => validateModelProviderMetadata({ ...valid, models: [valid.models[0], valid.models[0]] }),
    (error: unknown) => error instanceof ModelValidationError && error.path === "$metadata.models",
  );
});
