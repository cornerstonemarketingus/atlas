import assert from "node:assert/strict";
import test from "node:test";
import { UsageBudgetExceededError } from "../src/domain/usage-budget.js";
import { BudgetedModelProvider } from "../src/infrastructure/budgeted-model-provider.js";
import { InMemoryUsageBudgetLedger } from "../src/infrastructure/in-memory-usage-budget-ledger.js";
import { MockModelProvider } from "../src/infrastructure/mock-model-provider.js";
import type { ModelProviderMetadata, ModelResponse } from "../src/model/model-provider.js";

const metadata: ModelProviderMetadata = {
  id: "mock",
  displayName: "Mock",
  models: [{
    model: "test",
    contextWindowTokens: 100,
    maxOutputTokens: 50,
    supportsTools: false,
    supportsJson: false,
    supportsStreaming: false,
  }],
};

function response(outputTokens: number): ModelResponse {
  return {
    id: "response",
    providerId: "mock",
    model: "test",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    finishReason: "stop",
    usage: { inputTokens: 3, outputTokens, totalTokens: 3 + outputTokens, estimatedCostUsd: 0.01 },
  };
}

test("caps requested output and records provider-reported usage", async () => {
  const mock = new MockModelProvider({ metadata, responses: [response(4)] });
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 5, inputTokens: 10, costUsd: 1 });
  const provider = new BudgetedModelProvider(mock, ledger);

  await provider.complete({ model: "test", messages: [], maxOutputTokens: 20 });

  assert.equal(mock.requests[0]?.maxOutputTokens, 5);
  assert.equal(ledger.snapshot().used.outputTokens, 4);
  assert.equal(ledger.snapshot().used.inputTokens, 3);
});

test("rejects requests when no output-token budget remains", async () => {
  const mock = new MockModelProvider({ metadata, responses: [response(1)] });
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 0 });
  const provider = new BudgetedModelProvider(mock, ledger);

  await assert.rejects(
    provider.complete({ model: "test", messages: [] }),
    (error: unknown) => error instanceof UsageBudgetExceededError,
  );
  assert.equal(mock.requests.length, 0);
});
