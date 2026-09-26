import { BudgetExceededError, BudgetLedger, normalizeBudget } from "./budget.mjs";
import { AdaptiveBatchSize, classifyRateLimit } from "./provider-throttle.mjs";

const CHILD_STATES = new Set([
  "pending",
  "running",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
  "blocked",
]);
const TERMINAL_CHILD_STATES = new Set(["completed", "failed", "cancelled", "blocked"]);
const TERMINAL_MISSION_STATES = new Set(["completed", "failed", "cancelled"]);
const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  elapsedMs: 0,
  costMicroUsd: 0,
});

export class MissionPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MissionPlanError";
    this.code = code;
  }
}

/**
 * Validates and normalizes a child-agent mission before anything can run.
 * Dependencies are deliberately mandatory, including `dependencies: []` for
 * a root child, so an omitted edge cannot accidentally turn sequential work
 * into parallel work.
 */
export function normalizeMissionPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new MissionPlanError("INVALID_PLAN", "A mission plan object is required.");
  }
  if (!Array.isArray(plan.children) || plan.children.length === 0) {
    throw new MissionPlanError("INVALID_PLAN", "A mission must contain at least one child.");
  }

  const ids = new Set();
  const children = plan.children.map((raw, order) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MissionPlanError("INVALID_CHILD", `Child at index ${order} must be an object.`);
    }
    const id = normalizeId(raw.id, `Child at index ${order}`);
    if (ids.has(id)) throw new MissionPlanError("DUPLICATE_CHILD", `Child '${id}' is declared more than once.`);
    ids.add(id);
    if (!Object.hasOwn(raw, "dependencies") || !Array.isArray(raw.dependencies)) {
      throw new MissionPlanError("IMPLICIT_DEPENDENCIES", `Child '${id}' must declare dependencies explicitly (use [] for none).`);
    }
    const dependencies = raw.dependencies.map((dependency) => normalizeId(dependency, `Dependency of '${id}'`));
    if (new Set(dependencies).size !== dependencies.length) {
      throw new MissionPlanError("DUPLICATE_DEPENDENCY", `Child '${id}' contains a duplicate dependency.`);
    }
    const resourceLocks = raw.resourceLocks === undefined ? [] : raw.resourceLocks;
    if (!Array.isArray(resourceLocks)) {
      throw new MissionPlanError("INVALID_LOCKS", `Child '${id}' resourceLocks must be an array.`);
    }
    const locks = resourceLocks.map((lock) => normalizeLock(lock, id));
    if (new Set(locks).size !== locks.length) {
      throw new MissionPlanError("DUPLICATE_LOCK", `Child '${id}' requests the same resource lock more than once.`);
    }
    let budget;
    try { budget = normalizeBudget(raw.budget); }
    catch (error) { throw new MissionPlanError("INVALID_BUDGET", `Child '${id}' has an invalid budget: ${error.message}`); }
    return {
      id,
      order,
      objective: typeof raw.objective === "string" ? raw.objective : "",
      dependencies,
      resourceLocks: [...locks].sort(),
      budget,
      metadata: jsonValue(raw.metadata ?? null, `Child '${id}' metadata`),
    };
  });

  for (const child of children) {
    for (const dependency of child.dependencies) {
      if (dependency === child.id) throw new MissionPlanError("SELF_DEPENDENCY", `Child '${child.id}' cannot depend on itself.`);
      if (!ids.has(dependency)) {
        throw new MissionPlanError("UNKNOWN_DEPENDENCY", `Child '${child.id}' depends on unknown child '${dependency}'.`);
      }
    }
  }
  assertAcyclic(children);
  return {
    id: normalizeId(plan.id ?? "mission", "Mission"),
    title: typeof plan.title === "string" ? plan.title : "",
    children,
  };
}

/**
 * A bounded, dependency-aware child scheduler.
 *
 * The executor receives `{ child, signal, budget, checkpoint }`. It can charge
 * tokens, tool calls and cost through `budget.record(...)`; elapsed time is
 * charged by the scheduler. All writing agents should name the repository or
 * worktree they mutate in `resourceLocks`, making conflicting children wait.
 *
 * Children run in batches of at most `maxConcurrency`. A child that ends on a
 * provider rate limit is requeued rather than failed: the batch size halves,
 * nothing new launches until the provider's reset time, and the batch grows
 * back after clean completions (see provider-throttle.mjs). A child that keeps
 * hitting the limit fails after `maxRateLimitRetries` requeues.
 */
export class MissionScheduler {
  #plan;
  #execute;
  #maxConcurrency;
  #onStateChange;
  #clock;
  #setTimer;
  #clearTimer;
  #children;
  #status = "pending";
  #reason = null;
  #startedAt = null;
  #completedAt = null;
  #controllers = new Map();
  #locks = new Map();
  #running = new Map();
  #drainPromise = null;
  #resolveDrain = null;
  #resumePromise = null;
  #pumping = false;
  #batch;
  #maxRateLimitRetries;
  #throttledUntil = null;
  #throttleTimer = null;
  #consecutiveLimits = 0;

  constructor({ plan, execute, maxConcurrency = 2, maxRateLimitRetries = 6, onStateChange = () => {}, clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.#plan = normalizeMissionPlan(plan);
    if (typeof execute !== "function") throw new Error("A child executor function is required.");
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error("maxConcurrency must be a positive integer.");
    if (typeof onStateChange !== "function") throw new Error("onStateChange must be a function.");
    this.#execute = execute;
    this.#maxConcurrency = maxConcurrency;
    if (!Number.isInteger(maxRateLimitRetries) || maxRateLimitRetries < 0) throw new Error("maxRateLimitRetries must be a non-negative integer.");
    this.#maxRateLimitRetries = maxRateLimitRetries;
    this.#batch = new AdaptiveBatchSize({ max: maxConcurrency });
    this.#onStateChange = onStateChange;
    this.#clock = clock;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#children = new Map(this.#plan.children.map((child) => [child.id, {
      ...child,
      state: "pending",
      attempts: 0,
      rateLimits: 0,
      usage: { ...EMPTY_USAGE },
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    }]));
  }

  /** Restores JSON state. Work that was running is made explicitly interrupted. */
  static restore({ snapshot, execute, onStateChange, clock, setTimer, clearTimer }) {
    validateSnapshot(snapshot);
    const scheduler = new MissionScheduler({
      plan: snapshot.plan,
      execute,
      maxConcurrency: snapshot.maxConcurrency,
      onStateChange,
      clock,
      setTimer,
      clearTimer,
    });
    scheduler.#status = snapshot.status === "running" ? "interrupted" : snapshot.status;
    scheduler.#reason = snapshot.reason ?? (snapshot.status === "running" ? "Atlas restarted while child agents were running." : null);
    scheduler.#startedAt = snapshot.startedAt ?? null;
    scheduler.#completedAt = snapshot.completedAt ?? null;
    for (const saved of snapshot.children) {
      const child = scheduler.#children.get(saved.id);
      child.state = saved.state === "running" ? "interrupted" : saved.state;
      child.attempts = saved.attempts;
      child.rateLimits = Number.isInteger(saved.rateLimits) ? saved.rateLimits : 0;
      child.usage = { ...EMPTY_USAGE, ...saved.usage };
      child.startedAt = saved.startedAt ?? null;
      child.completedAt = saved.completedAt ?? null;
      child.result = jsonValue(saved.result ?? null, `Saved result for '${saved.id}'`);
      child.error = saved.state === "running"
        ? { code: "INTERRUPTED", message: "Atlas restarted while this child was running." }
        : jsonValue(saved.error ?? null, `Saved error for '${saved.id}'`);
    }
    return scheduler;
  }

  get status() { return this.#status; }
  get maxConcurrency() { return this.#maxConcurrency; }
  /** The batch size in force now: `maxConcurrency`, or less after a rate limit. */
  get batchSize() { return this.#batch.current; }
  child(id) { return this.#children.has(id) ? publicChild(this.#children.get(id)) : null; }
  children() { return this.#plan.children.map(({ id }) => publicChild(this.#children.get(id))); }

  /** Starts a new mission or safely requeues children interrupted by restart. */
  start() {
    if (this.#drainPromise) {
      if (this.#status === "interrupted") this.resume();
      return this.#drainPromise;
    }
    if (TERMINAL_MISSION_STATES.has(this.#status)) return Promise.resolve(this.snapshot());
    for (const child of this.#children.values()) {
      if (child.state === "interrupted") child.state = "pending";
    }
    this.#status = "running";
    this.#reason = null;
    this.#startedAt ??= new Date(this.#clock()).toISOString();
    this.#drainPromise = new Promise((resolve) => { this.#resolveDrain = resolve; });
    this.#changed();
    this.#pump();
    return this.#drainPromise;
  }

  resume() {
    if (this.#status !== "interrupted") return this.#drainPromise ?? Promise.resolve(this.snapshot());
    if (this.#resumePromise) return this.#resumePromise;
    this.#resumePromise = Promise.allSettled([...this.#running.values()]).then(() => {
      if (this.#status !== "interrupted") return this.#drainPromise ?? this.snapshot();
      for (const child of this.#children.values()) {
        if (child.state === "interrupted") child.state = "pending";
      }
      this.#status = "running";
      this.#reason = null;
      this.#resumePromise = null;
      this.#changed();
      this.#pump();
      return this.#drainPromise;
    });
    return this.#resumePromise;
  }

  /**
   * Pauses at the scheduler boundary and interrupts every active child.
   * Interrupted children retain their recorded usage and are requeued by the
   * next start(), so pausing never grants a fresh budget or repeats a child
   * that already reached a terminal state.
   */
  pause(reason = "Mission paused by the operator.") {
    if (this.#status !== "running") return this.snapshot();
    this.#status = "interrupted";
    this.#reason = String(reason);
    this.#clearThrottle();
    for (const controller of this.#controllers.values()) {
      controller.abort(new MissionPausedError(this.#reason));
    }
    this.#changed();
    return this.snapshot();
  }

  /** Cancels pending descendants and propagates an AbortSignal to every running child. */
  cancel(reason = "Mission cancelled by the operator.") {
    if (TERMINAL_MISSION_STATES.has(this.#status)) return this.snapshot();
    this.#status = "cancelled";
    this.#reason = String(reason);
    this.#clearThrottle();
    for (const child of this.#children.values()) {
      if (["pending", "interrupted"].includes(child.state)) {
        child.state = "cancelled";
        child.error = { code: "MISSION_CANCELLED", message: this.#reason };
        child.completedAt = new Date(this.#clock()).toISOString();
      }
    }
    for (const controller of this.#controllers.values()) controller.abort(new MissionCancelledError(this.#reason));
    this.#changed();
    this.#pump();
    return this.snapshot();
  }

  snapshot() {
    return jsonValue({
      schemaVersion: 1,
      plan: this.#plan,
      maxConcurrency: this.#maxConcurrency,
      throttle: {
        batchSize: this.#batch.current,
        waitingUntil: this.#throttledUntil === null ? null : new Date(this.#throttledUntil).toISOString(),
      },
      status: this.#status,
      reason: this.#reason,
      startedAt: this.#startedAt,
      completedAt: this.#completedAt,
      children: this.children(),
    }, "Mission snapshot");
  }

  #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      this.#blockFailedDescendants();
      if (this.#status === "running" && !this.#throttled()) {
        for (const child of this.#readyChildren()) {
          if (this.#running.size >= this.#batch.current) break;
          if (!this.#locksAvailable(child)) continue;
          this.#launch(child);
        }
      }

      if (this.#running.size === 0 && this.children().every((child) => TERMINAL_CHILD_STATES.has(child.state))) {
        if (this.#status !== "cancelled") {
          const failed = this.children().some((child) => child.state === "failed" || child.state === "blocked");
          this.#status = failed ? "failed" : "completed";
          this.#reason = failed ? "One or more child agents failed or were blocked." : null;
        }
        this.#completedAt = new Date(this.#clock()).toISOString();
        this.#changed();
        const resolve = this.#resolveDrain;
        const final = this.snapshot();
        this.#resolveDrain = null;
        this.#drainPromise = null;
        resolve?.(final);
      }
    } finally {
      this.#pumping = false;
    }
  }

  #readyChildren() {
    return this.#plan.children
      .map(({ id }) => this.#children.get(id))
      .filter((child) => child.state === "pending" && child.dependencies.every((id) => this.#children.get(id).state === "completed"))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  #locksAvailable(child) {
    return child.resourceLocks.every((resource) => !this.#locks.has(resource));
  }

  #launch(child) {
    child.state = "running";
    child.attempts += 1;
    child.startedAt = new Date(this.#clock()).toISOString();
    child.completedAt = null;
    child.error = null;
    for (const resource of child.resourceLocks) this.#locks.set(resource, child.id);
    const controller = new AbortController();
    this.#controllers.set(child.id, controller);
    const run = this.#runChild(child, controller)
      .finally(() => {
        this.#running.delete(child.id);
        this.#controllers.delete(child.id);
        for (const resource of child.resourceLocks) {
          if (this.#locks.get(resource) === child.id) this.#locks.delete(resource);
        }
        this.#changed();
        this.#pump();
      });
    this.#running.set(child.id, run);
    this.#changed();
  }

  async #runChild(child, controller) {
    const budget = new BudgetLedger({
      limits: child.budget,
      used: child.usage,
      onChange: ({ used }) => { child.usage = used; this.#changed(); },
    });
    const remainingMs = budget.remaining().elapsedMs;
    if (remainingMs <= 0) {
      child.state = "failed";
      child.error = { code: "BUDGET_EXCEEDED", message: "The child has no elapsed-time budget remaining." };
      child.completedAt = new Date(this.#clock()).toISOString();
      return;
    }

    const began = this.#clock();
    let timedOut = false;
    const timer = this.#setTimer(() => {
      timedOut = true;
      controller.abort(new BudgetExceededError("elapsedMs", child.budget.elapsedMs + 1, child.budget.elapsedMs));
    }, remainingMs);
    const checkpoint = () => {
      if (controller.signal.aborted) throw controller.signal.reason ?? new MissionCancelledError("Child execution was cancelled.");
    };

    try {
      const result = await this.#execute({ child: publicChild(child), signal: controller.signal, budget, checkpoint });
      checkpoint();
      if (result?.usage) budget.record(result.usage);
      if (result?.status === "failed" && this.#requeueIfRateLimited(child, result)) {
        // Requeued: the provider refused, the child did not fail.
      } else if (result?.status === "failed") {
        child.state = "failed";
        child.error = { code: result.code ?? "CHILD_FAILED", message: String(result.summary ?? "Child agent failed.") };
      } else if (result?.status === "cancelled") {
        child.state = "cancelled";
        child.error = { code: result.code ?? "CHILD_CANCELLED", message: String(result.summary ?? "Child agent cancelled.") };
      } else {
        child.state = "completed";
        child.result = jsonValue(result ?? null, `Result for '${child.id}'`);
        this.#consecutiveLimits = 0;
        this.#batch.succeeded();
      }
    } catch (error) {
      if (this.#status === "interrupted" && controller.signal.aborted && !timedOut) {
        child.state = "interrupted";
        child.error = { code: "MISSION_PAUSED", message: this.#reason ?? "Mission paused." };
      } else if (this.#status === "cancelled" || (controller.signal.aborted && !timedOut)) {
        child.state = "cancelled";
        child.error = { code: "MISSION_CANCELLED", message: this.#reason ?? "Mission cancelled." };
      } else if (!timedOut && this.#requeueIfRateLimited(child, error)) {
        // Requeued: the provider refused, the child did not fail.
      } else {
        child.state = "failed";
        child.error = { code: error?.code ?? (timedOut ? "BUDGET_EXCEEDED" : "CHILD_ERROR"), message: timedOut ? "The child exceeded its elapsed-time budget." : String(error?.message ?? error) };
      }
    } finally {
      this.#clearTimer(timer);
      const elapsed = Math.max(0, Math.floor(this.#clock() - began));
      // Timer callbacks can run just before the observable clock advances to
      // the deadline (for example, 19 ms for a 20 ms timer). Once the timeout
      // fired, the child consumed its complete remaining elapsed allowance;
      // recording less would make a restart appear to regain time.
      const charge = timedOut
        ? budget.remaining().elapsedMs
        : Math.min(elapsed, budget.remaining().elapsedMs);
      if (charge > 0) budget.record({ elapsedMs: charge });
      child.usage = budget.used;
      child.completedAt = new Date(this.#clock()).toISOString();
    }
  }

  /**
   * Requeues a child whose failure was a provider rate limit, shrinks the
   * batch, and holds new launches until the provider's reset time. Returns
   * false when the failure is not a rate limit or retries are exhausted.
   */
  #requeueIfRateLimited(child, failure) {
    const now = this.#clock();
    const limit = classifyRateLimit(failure, { now, consecutive: this.#consecutiveLimits });
    if (!limit.rateLimited) return false;
    child.rateLimits += 1;
    if (child.rateLimits > this.#maxRateLimitRetries) {
      child.state = "failed";
      child.error = { code: "RATE_LIMITED", message: `The provider kept rate limiting this child (${child.rateLimits} times); giving up.` };
      return true;
    }
    this.#consecutiveLimits += 1;
    this.#batch.rateLimited();
    child.state = "pending";
    child.error = { code: "RATE_LIMITED", message: "Waiting for the model provider's rate limit to reset.", retryAt: new Date(limit.retryAt).toISOString() };
    this.#throttleUntil(limit.retryAt);
    return true;
  }

  #throttled() {
    return this.#throttledUntil !== null && this.#clock() < this.#throttledUntil;
  }

  /** Holds launches until `until`; a later reset extends the hold, an earlier one never shortens it. */
  #throttleUntil(until) {
    if (this.#throttledUntil !== null && this.#throttledUntil >= until) return;
    this.#clearThrottle();
    this.#throttledUntil = until;
    this.#throttleTimer = this.#setTimer(() => {
      this.#throttleTimer = null;
      this.#throttledUntil = null;
      this.#changed();
      this.#pump();
    }, Math.max(0, until - this.#clock()));
  }

  #clearThrottle() {
    if (this.#throttleTimer !== null) this.#clearTimer(this.#throttleTimer);
    this.#throttleTimer = null;
    this.#throttledUntil = null;
  }

  #blockFailedDescendants() {
    let changed = false;
    do {
      changed = false;
      for (const child of this.#children.values()) {
        if (!['pending', 'interrupted'].includes(child.state)) continue;
        const dependency = child.dependencies.map((id) => this.#children.get(id)).find((candidate) => ["failed", "cancelled", "blocked"].includes(candidate.state));
        if (!dependency) continue;
        child.state = this.#status === "cancelled" ? "cancelled" : "blocked";
        child.error = {
          code: this.#status === "cancelled" ? "MISSION_CANCELLED" : "DEPENDENCY_FAILED",
          message: this.#status === "cancelled" ? this.#reason : `Dependency '${dependency.id}' ended as ${dependency.state}.`,
        };
        child.completedAt = new Date(this.#clock()).toISOString();
        changed = true;
      }
    } while (changed);
  }

  #changed() {
    this.#onStateChange(this.snapshot());
  }
}

class MissionCancelledError extends Error {
  constructor(message) { super(message); this.name = "MissionCancelledError"; this.code = "MISSION_CANCELLED"; }
}

class MissionPausedError extends Error {
  constructor(message) { super(message); this.name = "MissionPausedError"; this.code = "MISSION_PAUSED"; }
}

function publicChild(child) {
  return jsonValue({
    id: child.id,
    order: child.order,
    objective: child.objective,
    dependencies: child.dependencies,
    resourceLocks: child.resourceLocks,
    budget: child.budget,
    metadata: child.metadata,
    state: child.state,
    attempts: child.attempts,
    rateLimits: child.rateLimits,
    usage: child.usage,
    startedAt: child.startedAt,
    completedAt: child.completedAt,
    result: child.result,
    error: child.error,
  }, `Child '${child.id}' state`);
}

function normalizeId(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new MissionPlanError("INVALID_ID", `${label} id must use 1-64 lowercase letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}

function normalizeLock(value, childId) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f]/u.test(value)) {
    throw new MissionPlanError("INVALID_LOCK", `Child '${childId}' contains an invalid resource lock.`);
  }
  return value;
}

function assertAcyclic(children) {
  const indegree = new Map(children.map((child) => [child.id, child.dependencies.length]));
  const dependents = new Map(children.map((child) => [child.id, []]));
  for (const child of children) for (const dependency of child.dependencies) dependents.get(dependency).push(child.id);
  const ready = children.filter((child) => indegree.get(child.id) === 0).sort((a, b) => a.order - b.order);
  let visited = 0;
  while (ready.length) {
    const child = ready.shift();
    visited += 1;
    for (const id of dependents.get(child.id)) {
      indegree.set(id, indegree.get(id) - 1);
      if (indegree.get(id) === 0) ready.push(children.find((candidate) => candidate.id === id));
    }
    ready.sort((a, b) => a.order - b.order);
  }
  if (visited !== children.length) {
    const cycle = children.filter((child) => indegree.get(child.id) > 0).map((child) => child.id).sort();
    throw new MissionPlanError("DEPENDENCY_CYCLE", `Mission dependency cycle detected among: ${cycle.join(", ")}.`);
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !snapshot.plan || !Array.isArray(snapshot.children)) {
    throw new MissionPlanError("INVALID_SNAPSHOT", "Unsupported or malformed mission snapshot.");
  }
  const plan = normalizeMissionPlan(snapshot.plan);
  if (snapshot.children.length !== plan.children.length) throw new MissionPlanError("INVALID_SNAPSHOT", "Mission snapshot child count does not match its plan.");
  const ids = new Set(plan.children.map((child) => child.id));
  for (const child of snapshot.children) {
    if (!ids.delete(child.id) || !CHILD_STATES.has(child.state) || !Number.isInteger(child.attempts) || child.attempts < 0) {
      throw new MissionPlanError("INVALID_SNAPSHOT", "Mission snapshot contains invalid child state.");
    }
  }
  if (!["pending", "running", "interrupted", "completed", "failed", "cancelled"].includes(snapshot.status)) {
    throw new MissionPlanError("INVALID_SNAPSHOT", "Mission snapshot contains an invalid status.");
  }
}

function jsonValue(value, label) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON serializable");
    return JSON.parse(encoded);
  } catch (error) {
    throw new MissionPlanError("NON_SERIALIZABLE_STATE", `${label} must be JSON serializable: ${error.message}`);
  }
}
