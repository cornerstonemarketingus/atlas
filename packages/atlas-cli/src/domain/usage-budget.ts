export interface UsageAmounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly elapsedMilliseconds: number;
  readonly toolCalls: number;
}

export interface UsageBudgetLimits {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly elapsedMilliseconds?: number;
  readonly toolCalls?: number;
}

export interface UsageBudgetSnapshot {
  readonly used: UsageAmounts;
  readonly limits: UsageBudgetLimits;
  readonly remaining: UsageBudgetLimits;
}

export type UsageBudgetDimension = keyof UsageAmounts;

export class UsageBudgetExceededError extends Error {
  public constructor(
    public readonly dimension: UsageBudgetDimension,
    public readonly attempted: number,
    public readonly limit: number,
  ) {
    super(`Usage budget '${dimension}' would reach ${attempted}, exceeding limit ${limit}.`);
    this.name = "UsageBudgetExceededError";
  }
}

export interface UsageBudgetLedger {
  record(amounts: Partial<UsageAmounts>): UsageBudgetSnapshot;
  snapshot(): UsageBudgetSnapshot;
}
