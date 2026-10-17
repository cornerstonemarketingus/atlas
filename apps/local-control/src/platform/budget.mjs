import { BUDGET_DIMENSIONS } from "../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Task and ancestor budget enforcement over existing durable task rows.
 * Delegated execution reserves/charges every ancestor atomically; this does
 * not backfill descendant usage recorded before this accounting was enabled.
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

  #tasks() {
    const tasks = []; const seen = new Set(); let task = this.#task();
    while (task) {
      if (seen.has(task.id) || tasks.length >= 64) throw new Error("Budget parent chain is cyclic or exceeds 64 tasks.");
      seen.add(task.id); tasks.push(task);
      if (!task.parentTaskId) break;
      task = this.#store.getTask(this.#tenantId, task.parentTaskId);
      if (!task) throw new Error("Budget parent does not exist in this tenant.");
    }
    return tasks;
  }

  snapshot() {
    return this.#store.transaction(() => {
      const tasks = this.#tasks(); const { budget, usage = {} } = tasks[0];
      const remaining = {};
      for (const task of tasks) for (const dimension of BUDGET_DIMENSIONS) {
        if (task.budget[dimension] === undefined) continue;
        const left = Math.max(0, task.budget[dimension] - (task.usage?.[dimension] ?? 0));
        remaining[dimension] = Math.min(remaining[dimension] ?? Infinity, left);
      }
      return { limits: { ...budget }, used: { ...usage }, remaining,
        ...(tasks.length > 1 ? { ancestors: tasks.slice(1).map(task => ({ taskId: task.id, limits: task.budget, used: task.usage })) } : {}) };
    });
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
      const tasks = this.#tasks();
      // Validate every scope before writing any reservation.
      for (const task of tasks) {
        const usage = task.usage ?? {};
        for (const dimension of BUDGET_DIMENSIONS) {
          const limit = task.budget[dimension];
          if (limit === undefined) continue;
          const used = usage[dimension] ?? 0;
          const attempted = used + (amounts[dimension] ?? 0);
          const alreadySpent = (amounts[dimension] ?? 0) === 0 && (limit > 0 ? used >= limit : used > limit);
          if (attempted > limit || alreadySpent) {
            const over = { dimension, attempted, limit };
            this.#emit(task, "budget.exceeded", { phase: "reserve", sourceTaskId: this.#taskId, ...over, usage });
            return over;
          }
        }
      }
      for (const task of tasks) {
        const next = { ...(task.usage ?? {}) };
        for (const [dimension, value] of Object.entries(amounts)) next[dimension] = (next[dimension] ?? 0) + value;
        this.#store.recordUsage(this.#tenantId, task.id, next);
        this.#emit(task, "budget.charged", { phase: "reserve", sourceTaskId: this.#taskId, amounts, usage: next });
      }
      return null;
    });
    if (refusal) throw new TaskBudgetExceededError(refusal.dimension, refusal.attempted, refusal.limit);
    return this.snapshot();
  }

  /** Records actual consumption after execution; returns `{ exceeded, snapshot }`. */
  charge(amounts = {}) {
    checkAmounts(amounts);
    const exceeded = this.#store.transaction(() => {
      const over = [];
      for (const task of this.#tasks()) {
        const next = { ...(task.usage ?? {}) };
        for (const [dimension, value] of Object.entries(amounts)) next[dimension] = (next[dimension] ?? 0) + value;
        this.#store.recordUsage(this.#tenantId, task.id, next);
        this.#emit(task, "budget.charged", { phase: "charge", sourceTaskId: this.#taskId, amounts, usage: next });
        const exceeded = BUDGET_DIMENSIONS
          .filter(d => task.budget[d] !== undefined && next[d] > task.budget[d])
          .map(d => ({ dimension: d, attempted: next[d], limit: task.budget[d] }));
        if (exceeded.length) this.#emit(task, "budget.exceeded", { phase: "charge", sourceTaskId: this.#taskId, over: exceeded, usage: next });
        over.push(...exceeded);
      }
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
