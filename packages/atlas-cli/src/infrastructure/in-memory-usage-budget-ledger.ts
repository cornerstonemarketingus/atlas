import {
  UsageBudgetExceededError,
  type UsageAmounts,
  type UsageBudgetDimension,
  type UsageBudgetLedger,
  type UsageBudgetLimits,
  type UsageBudgetSnapshot,
} from "../domain/usage-budget.js";

const DIMENSIONS: readonly UsageBudgetDimension[] = [
  "inputTokens", "outputTokens", "costUsd", "elapsedMilliseconds", "toolCalls",
];

const ZERO_USAGE: UsageAmounts = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  elapsedMilliseconds: 0,
  toolCalls: 0,
};

export class InMemoryUsageBudgetLedger implements UsageBudgetLedger {
  #used: UsageAmounts = ZERO_USAGE;

  public constructor(private readonly limits: UsageBudgetLimits = {}) {
    validateValues(limits, "limit");
  }

  public record(amounts: Partial<UsageAmounts>): UsageBudgetSnapshot {
    validateValues(amounts, "usage");
    const proposed = { ...this.#used };
    for (const dimension of DIMENSIONS) {
      proposed[dimension] += amounts[dimension] ?? 0;
      const limit = this.limits[dimension];
      if (limit !== undefined && proposed[dimension] > limit) {
        throw new UsageBudgetExceededError(dimension, proposed[dimension], limit);
      }
    }
    this.#used = proposed;
    return this.snapshot();
  }

  public snapshot(): UsageBudgetSnapshot {
    const remaining: Partial<Record<UsageBudgetDimension, number>> = {};
    for (const dimension of DIMENSIONS) {
      const limit = this.limits[dimension];
      if (limit !== undefined) remaining[dimension] = Math.max(0, limit - this.#used[dimension]);
    }
    return {
      used: { ...this.#used },
      limits: { ...this.limits },
      remaining,
    };
  }
}

function validateValues(
  values: Partial<Record<UsageBudgetDimension, number>>,
  kind: "limit" | "usage",
): void {
  for (const dimension of DIMENSIONS) {
    const value = values[dimension];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Usage budget ${kind} '${dimension}' must be a non-negative finite number.`);
    }
    if (dimension !== "costUsd" && !Number.isSafeInteger(value)) {
      throw new RangeError(`Usage budget ${kind} '${dimension}' must be a safe integer.`);
    }
  }
}
