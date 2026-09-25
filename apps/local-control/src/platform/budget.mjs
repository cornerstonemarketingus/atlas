import { BUDGET_DIMENSIONS } from "../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Per-task budget enforcement over the durable task row.
 *
 * Limits come from the task's `budget` and usage lives on the task's `usage`,
 * both persisted by the store, so a restarted control plane resumes with what
 * is actually left rather than a fresh allowance. A dimension the task's
 * budget does not name is unlimited.
 *
 * The protocol is reserve-before-execute, charge-after:
 * - `reserve()` takes one tool call before anything runs and refuses the
 *   whole increment when it would overrun, or when any dimension is already
 *   spent. Nothing is recorded on refusal, matching src/agent/budget.mjs, so
 *   a caller cannot creep past a limit in small pieces.
 * - `charge()` records what the call actually consumed. Work that already
 *   happened is recorded truthfully even if it crosses a limit (hiding it
 *   would falsify the audit); the overrun emits `budget.exceeded` and the
 *   next `reserve()` is refused.
 */
export class TaskBudgetExceededError extends Error {
  constructor(dimension, attempted, limit) {
    super(`Task budget '${dimension}' would reach ${attempted}, exceeding the limit of ${limit}.`);
    this.name = "TaskBudgetExceededError";
    this.code = "BUDGET_EXCEEDED";
    this.dimension = dimension;
    this.attempted = attempted;
    this.limit = limit;
  }
}

function checkAmounts(amounts) {
  for (const [dimension, value] of Object.entries(amounts)) {
    if (!BUDGET_DIMENSIONS.includes(dimension)) throw new Error(`Unknown budget dimension: ${dimension}.`);
    if (!Number.isInteger(value) || value < 0) throw new Error(`Budget usage '${dimension}' must be a non-negative integer.`);
  }
}

export class TaskBudget {
  #store;
  #tenantId;
  #taskId;

  constructor({ store, tenantId, taskId }) {
    this.#store = store;
    this.#tenantId = tenantId;
    this.#taskId = taskId;
  }

  #task() {
    const task = this.#store.getTask(this.#tenantId, this.#taskId);
    if (!task) throw new Error("Budget refers to a task that does not exist in this tenant.");
    return task;
  }

  snapshot() {
    const { budget, usage = {} } = this.#task();
    const remaining = Object.fromEntries(
      BUDGET_DIMENSIONS.filter((d) => budget[d] !== undefined).map((d) => [d, Math.max(0, budget[d] - (usage[d] ?? 0))]),
    );
    return { limits: { ...budget }, used: { ...usage }, remaining };
  }

  /** Remaining allowance for one dimension, or Infinity when the task sets no limit on it. */
  remaining(dimension) {
    const { remaining } = this.snapshot();
    return remaining[dimension] ?? Infinity;
  }

  /**
   * Reserves `amounts` (default one tool call) atomically. Throws
   * TaskBudgetExceededError, after recording a `budget.exceeded` event, when
   * the reservation cannot be honoured.
   */
  reserve(amounts = { toolCalls: 1 }) {
    checkAmounts(amounts);
    const refusal = this.#store.transaction(() => {
      const task = this.#task();
      const usage = task.usage ?? {};
      let over = null;
      for (const dimension of BUDGET_DIMENSIONS) {
        const limit = task.budget[dimension];
        if (limit === undefined) continue;
        const attempted = (usage[dimension] ?? 0) + (amounts[dimension] ?? 0);
        // A dimension already at a positive limit is spent; a zero limit only
        // forbids consuming it, so "no cost allowed" does not block free tools.
        const used = usage[dimension] ?? 0;
        const alreadySpent = (amounts[dimension] ?? 0) === 0 && (limit > 0 ? used >= limit : used > limit);
        if (attempted > limit || alreadySpent) {
          over = { dimension, attempted, limit };
          break;
        }
      }
      if (over) {
        this.#emit(task, "budget.exceeded", { phase: "reserve", ...over, usage });
        return over;
      }
      const next = { ...usage };
      for (const [dimension, value] of Object.entries(amounts)) next[dimension] = (next[dimension] ?? 0) + value;
      this.#store.recordUsage(this.#tenantId, this.#taskId, next);
      this.#emit(task, "budget.charged", { phase: "reserve", amounts, usage: next });
      return null;
    });
    if (refusal) throw new TaskBudgetExceededError(refusal.dimension, refusal.attempted, refusal.limit);
    return this.snapshot();
  }

  /** Records actual consumption after execution; returns `{ exceeded, snapshot }`. */
  charge(amounts = {}) {
    checkAmounts(amounts);
    const exceeded = this.#store.transaction(() => {
      const task = this.#task();
      const next = { ...(task.usage ?? {}) };
      for (const [dimension, value] of Object.entries(amounts)) next[dimension] = (next[dimension] ?? 0) + value;
      this.#store.recordUsage(this.#tenantId, this.#taskId, next);
      this.#emit(task, "budget.charged", { phase: "charge", amounts, usage: next });
      const over = BUDGET_DIMENSIONS
        .filter((d) => task.budget[d] !== undefined && next[d] > task.budget[d])
        .map((d) => ({ dimension: d, attempted: next[d], limit: task.budget[d] }));
      if (over.length > 0) this.#emit(task, "budget.exceeded", { phase: "charge", over, usage: next });
      return over;
    });
    return { exceeded, snapshot: this.snapshot() };
  }

  #emit(task, type, payload) {
    this.#store.appendEvent({
      type, tenantId: task.tenantId, correlationId: task.correlationId, taskId: task.id,
      userId: task.userId, agentId: task.agentId ?? null, payload,
    });
  }
}
