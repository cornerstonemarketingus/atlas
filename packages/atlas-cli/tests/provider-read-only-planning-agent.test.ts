import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderReadOnlyPlanningAgent } from "../src/agent/provider-read-only-planning-agent.js";
import { MockModelProvider } from "../src/infrastructure/mock-model-provider.js";
import type {
  ModelProviderMetadata,
  ModelResponse,
} from "../src/model/model-provider.js";

const metadata: ModelProviderMetadata = {
  id: "mock",
  displayName: "Mock",
  models: [{
    model: "test-model",
    contextWindowTokens: 8_192,
    maxOutputTokens: 1_024,
    supportsTools: true,
    supportsJson: true,
    supportsStreaming: false,
  }],
};

function response(
  content: ModelResponse["message"]["content"],
  finishReason: ModelResponse["finishReason"] = "stop",
): ModelResponse {
  return {
    id: `response-${finishReason}`,
    providerId: "mock",
    model: "test-model",
    message: { role: "assistant", content },
    finishReason,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

test("completes a plan from caller-supplied evidence without exposing tools", async () => {
  const provider = new MockModelProvider({
    metadata,
    responses: [response([{ type: "text", text: "Plan: preserve the interface." }])],
  });
  const agent = new ProviderReadOnlyPlanningAgent({ provider, model: "test-model" });

  const result = await agent.plan({
    objective: "Plan a safe refactor.",
    evidence: [{ label: "src/service.ts", content: "export interface Service {}" }],
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.response, "Plan: preserve the interface.");
  assert.equal(result.trace.turns, 1);
  assert.equal(provider.requests[0]?.tools, undefined);
  assert.match(JSON.stringify(provider.requests[0]?.messages), /src\/service\.ts/);
});

test("continues truncated output only up to the explicit turn bound", async () => {
  const provider = new MockModelProvider({
    metadata,
    responses: [
      response([{ type: "text", text: "Part one." }], "length"),
      response([{ type: "text", text: "Part two." }], "length"),
    ],
  });
  const agent = new ProviderReadOnlyPlanningAgent({
    provider,
    model: "test-model",
    maximumTurns: 2,
  });

  const result = await agent.plan({ objective: "Plan.", evidence: [] });

  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") return;
  assert.equal(result.blocker, "turn-limit");
  assert.equal(result.partialResponse, "Part one.\nPart two.");
  assert.equal(result.trace.turns, 2);
  assert.deepEqual(result.trace.usage, { inputTokens: 20, outputTokens: 10, totalTokens: 30 });
});

test("rejects tool calls instead of executing them", async () => {
  const provider = new MockModelProvider({
    metadata,
    responses: [response([{
      type: "tool-call",
      id: "call-1",
      name: "write_file",
      arguments: { path: "src/index.ts" },
    }], "tool-calls")],
  });
  const agent = new ProviderReadOnlyPlanningAgent({ provider, model: "test-model" });

  const result = await agent.plan({ objective: "Plan.", evidence: [] });

  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") return;
  assert.equal(result.blocker, "tool-call-unsupported");
  assert.match(result.message, /write_file/);
});

test("returns cancellation and does not call the provider when already aborted", async () => {
  const provider = new MockModelProvider({ metadata, responses: [] });
  const agent = new ProviderReadOnlyPlanningAgent({ provider, model: "test-model" });
  const controller = new AbortController();
  controller.abort();

  const result = await agent.plan({ objective: "Plan.", evidence: [], signal: controller.signal });

  assert.equal(result.status, "cancelled");
  assert.equal(provider.requests.length, 0);
});

test("normalizes provider errors into a failed result", async () => {
  const provider = new MockModelProvider({ metadata, responses: [] });
  const agent = new ProviderReadOnlyPlanningAgent({ provider, model: "test-model" });

  const result = await agent.plan({ objective: "Plan.", evidence: [] });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.providerId, "mock");
  assert.equal(result.retryable, false);
  assert.match(result.message, /no configured response/i);
});

test("blocks invalid and oversized caller input before invoking the provider", async () => {
  const provider = new MockModelProvider({ metadata, responses: [] });
  const agent = new ProviderReadOnlyPlanningAgent({
    provider,
    model: "test-model",
    maximumEvidenceCharacters: 5,
  });

  const empty = await agent.plan({ objective: " ", evidence: [] });
  const oversized = await agent.plan({
    objective: "Plan.",
    evidence: [{ label: "a", content: "12345" }],
  });

  assert.equal(empty.status, "blocked");
  assert.equal(oversized.status, "blocked");
  assert.equal(provider.requests.length, 0);
});
