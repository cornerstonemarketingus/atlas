import assert from "node:assert/strict";
import test from "node:test";
import { UsageBudgetExceededError } from "../src/domain/usage-budget.js";
import { InMemoryUsageBudgetLedger } from "../src/infrastructure/in-memory-usage-budget-ledger.js";

test("records usage and reports remaining limits", () => {
  const ledger = new InMemoryUsageBudgetLedger({ inputTokens: 100, costUsd: 1, toolCalls: 2 });
  const snapshot = ledger.record({ inputTokens: 40, outputTokens: 10, costUsd: 0.25, toolCalls: 1 });

  assert.equal(snapshot.used.inputTokens, 40);
  assert.equal(snapshot.used.outputTokens, 10);
  assert.equal(snapshot.remaining.inputTokens, 60);
  assert.equal(snapshot.remaining.costUsd, 0.75);
  assert.equal(snapshot.remaining.toolCalls, 1);
});

test("rejects an over-budget update atomically", () => {
  const ledger = new InMemoryUsageBudgetLedger({ inputTokens: 10, toolCalls: 1 });
  ledger.record({ inputTokens: 5 });

  assert.throws(
    () => ledger.record({ inputTokens: 6, toolCalls: 1 }),
    (error: unknown) => error instanceof UsageBudgetExceededError && error.dimension === "inputTokens",
  );
  assert.equal(ledger.snapshot().used.inputTokens, 5);
  assert.equal(ledger.snapshot().used.toolCalls, 0);
});

test("rejects invalid monetary and count values", () => {
  assert.throws(() => new InMemoryUsageBudgetLedger({ costUsd: Number.NaN }), /finite/u);
  const ledger = new InMemoryUsageBudgetLedger();
  assert.throws(() => ledger.record({ toolCalls: 0.5 }), /safe integer/u);
});
