/**
 * Budgets are enforced per session and survive restarts: a run that was
 * interrupted at 90% of its token budget resumes with 10% left, not with a
 * fresh allowance. That is the whole reason usage is persisted on the
 * session row rather than held in the runtime.
 */
export const BUDGET_DIMENSIONS = ["inputTokens", "outputTokens", "toolCalls", "elapsedMs", "costMicroUsd"];

export const DEFAULT_BUDGET = {
  inputTokens: 2_000_000,
  outputTokens: 400_000,
  toolCalls: 400,
  elapsedMs: 60 * 60 * 1000,
  costMicroUsd: 5_000_000,
};

export class BudgetExceededError extends Error {
  constructor(dimension, attempted, limit) {
    super(`Budget '${dimension}' would reach ${attempted}, exceeding the limit of ${limit}.`);
    this.name = "BudgetExceededError";
    this.code = "BUDGET_EXCEEDED";
    this.dimension = dimension;
    this.attempted = attempted;
    this.limit = limit;
  }
}

export function normalizeBudget(limits = {}) {
  const normalized = { ...DEFAULT_BUDGET };
  for (const [dimension, value] of Object.entries(limits)) {
    if (!BUDGET_DIMENSIONS.includes(dimension)) throw new Error(`Unknown budget dimension: ${dimension}.`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Budget '${dimension}' must be a non-negative number.`);
    normalized[dimension] = Math.floor(value);
  }
  return normalized;
}

function emptyUsage() {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0]));
}

/**
 * Records usage and refuses the increment that would cross a limit. The
 * increment is rejected whole: a partially charged budget would let a caller
 * exceed a limit by retrying the same call in smaller pieces.
 */
export class BudgetLedger {
  #limits;
  #used;
  #onChange;

  constructor({ limits = {}, used = {}, onChange = () => {} } = {}) {
    this.#limits = normalizeBudget(limits);
    this.#used = { ...emptyUsage(), ...used };
    this.#onChange = onChange;
  }

  get limits() { return { ...this.#limits }; }
  get used() { return { ...this.#used }; }

  remaining() {
    return Object.fromEntries(BUDGET_DIMENSIONS.map((d) => [d, Math.max(0, this.#limits[d] - this.#used[d])]));
  }

  /** Throws BudgetExceededError without recording anything when any dimension would overrun. */
  record(amounts = {}) {
    const next = { ...this.#used };
    for (const [dimension, value] of Object.entries(amounts)) {
      if (!BUDGET_DIMENSIONS.includes(dimension)) throw new Error(`Unknown budget dimension: ${dimension}.`);
      if (!Number.isFinite(value) || value < 0) throw new Error(`Budget usage '${dimension}' must be non-negative.`);
      next[dimension] = this.#used[dimension] + value;
      if (next[dimension] > this.#limits[dimension]) {
        throw new BudgetExceededError(dimension, next[dimension], this.#limits[dimension]);
      }
    }
    this.#used = next;
    this.#onChange(this.snapshot());
    return this.snapshot();
  }

  /** True when any dimension is spent, so a caller can stop before proposing more work. */
  exhausted() {
    return BUDGET_DIMENSIONS.some((dimension) => this.#used[dimension] >= this.#limits[dimension]);
  }

  snapshot() {
    return { limits: this.limits, used: this.used, remaining: this.remaining() };
  }
}
