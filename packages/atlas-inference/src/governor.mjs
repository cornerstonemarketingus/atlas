import { RateLimitState } from "./rate-limit-state.mjs";

/**
 * The inference governor: every model request asks it for a target before
 * sending, and it decides when and where the request runs.
 *
 * Atlas's logical parallelism (how many agents are working) is a product
 * decision; inference concurrency (how many model calls are in flight on a
 * target) is a property of the compute available right now. The governor is
 * where the two meet. Fourteen agents can be active while two model calls run
 * and the rest wait their turn; nothing about the agents is cut to fit. When
 * more capacity appears — a provider's window refills, a target is added, the
 * configured concurrency is raised — the same agents simply run more at once.
 *
 * A request names its candidate targets in order of preference. It is
 * granted the first candidate that has a free slot and the known capacity for
 * it. A later (usually smaller or slower) candidate is used only when the
 * first cannot take the request within `preferFirstWithinMs`: waiting a few
 * seconds for the stronger model beats degrading the work.
 *
 * A request that cannot be served before its deadline is not failed: it is
 * rejected with WAITING_FOR_INFERENCE and the time capacity is expected back,
 * so the caller can keep its work and resume. The deadline applies to waiting
 * for a provider's capacity to return. Waiting for a slot is waiting behind
 * work that is already running and finishing; that queue always moves, so it
 * is never a reason to hand work back.
 */

export const DEFAULT_CONCURRENCY_PER_TARGET = 4;
const MIN_WAKE_MS = 250;
/** Waiting for a free slot, not for provider capacity: release() wakes it, no timer needed. */
const SLOT = -1;

export class WaitingForInferenceError extends Error {
  /** @param {{ retryInMs: number, reason: string, targets: string[] }} details */
  constructor({ retryInMs, reason, targets }) {
    super("Model capacity is temporarily full.");
    this.name = "WaitingForInferenceError";
    this.code = "WAITING_FOR_INFERENCE";
    this.retryInMs = retryInMs;
    this.reason = reason;
    this.targets = targets;
  }
}

export class InferenceGovernor {
  #capacity;
  #now;
  #sleep;
  #concurrency;
  #onEvent;
  #waiters = [];
  #inFlight = new Map();
  #sequence = 0;
  #wakeAt = null;

  /**
   * @param {{
   *   capacity?: RateLimitState,
   *   now?: () => number,
   *   sleep?: (ms: number) => Promise<void>,
   *   concurrencyPerTarget?: number | ((key: string) => number),
   *   onEvent?: (type: string, data: object) => void,
   * }} [options]
   */
  constructor({ capacity = new RateLimitState(), now = undefined, sleep = defaultSleep, concurrencyPerTarget = DEFAULT_CONCURRENCY_PER_TARGET, onEvent = () => {} } = {}) {
    this.#capacity = capacity;
    // One clock for capacity and scheduling, or a reset time and a deadline disagree.
    this.#now = now ?? (() => capacity.now());
    this.#sleep = sleep;
    this.#concurrency = typeof concurrencyPerTarget === "function" ? concurrencyPerTarget : () => concurrencyPerTarget;
    this.#onEvent = onEvent;
  }

  get capacity() {
    return this.#capacity;
  }

  /**
   * Waits for a target and reserves it. Always call `release()` on the lease.
   *
   * @param {{
   *   targets: string[],
   *   estimatedTokens?: number,
   *   priority?: number,
   *   maxWaitMs?: number,
   *   preferFirstWithinMs?: number,
   *   taskId?: string,
   *   role?: string,
   *   signal?: AbortSignal,
   *   onEvent?: (type: string, data: object) => void,
   * }} request
   * @returns {Promise<{ key: string, index: number, waitedMs: number, release: () => void }>}
   */
  acquire(request) {
    const targets = [...new Set(request.targets ?? [])].filter(Boolean);
    if (targets.length === 0) return Promise.reject(new TypeError("acquire needs at least one target."));
    const waiter = {
      id: (this.#sequence += 1),
      targets,
      estimatedTokens: Math.max(0, request.estimatedTokens ?? 0),
      priority: request.priority ?? 0,
      preferFirstWithinMs: request.preferFirstWithinMs ?? 0,
      deadline: this.#now() + Math.max(0, request.maxWaitMs ?? 60_000),
      enqueuedAt: this.#now(),
      queuedReported: false,
      meta: { taskId: request.taskId, role: request.role },
      onEvent: request.onEvent ?? (() => {}),
      signal: request.signal,
    };
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    if (waiter.signal) {
      if (waiter.signal.aborted) {
        return Promise.reject(Object.assign(new Error("Inference request cancelled."), { code: "CANCELLED" }));
      }
      waiter.signal.addEventListener("abort", () => this.#remove(waiter, Object.assign(new Error("Inference request cancelled."), { code: "CANCELLED" })), { once: true });
    }
    this.#emit(waiter, "inference.requested", { targets, estimatedTokens: waiter.estimatedTokens, priority: waiter.priority });
    this.#waiters.push(waiter);
    // Higher priority first; first come, first served within a priority.
    this.#waiters.sort((a, b) => b.priority - a.priority || a.id - b.id);
    this.#pump();
    return promise;
  }

  /** What the governor is doing, for status pages and tests. */
  snapshot() {
    return {
      waiting: this.#waiters.map((waiter) => ({ id: waiter.id, priority: waiter.priority, targets: waiter.targets, role: waiter.meta.role })),
      inFlight: Object.fromEntries(this.#inFlight),
    };
  }

  #emit(waiter, type, data) {
    const payload = { ...data, ...(waiter.meta.role ? { role: waiter.meta.role } : {}), ...(waiter.meta.taskId ? { taskId: waiter.meta.taskId } : {}) };
    try { waiter.onEvent(type, payload); } catch { /* observers never break scheduling */ }
    try { this.#onEvent(type, payload); } catch { /* same */ }
  }

  #remove(waiter, error) {
    const index = this.#waiters.indexOf(waiter);
    if (index === -1) return;
    this.#waiters.splice(index, 1);
    waiter.reject(error);
    this.#pump();
  }

  /** How long until `key` could take this waiter: 0 now, SLOT when only a slot is missing, Infinity never. */
  #waitFor(key, waiter) {
    const slots = this.#concurrency(key) - (this.#inFlight.get(key) ?? 0);
    const gate = this.#capacity.check(key, waiter.estimatedTokens);
    if (!gate.ok) return gate.waitMs;
    return slots > 0 ? 0 : SLOT;
  }

  #grant(waiter, key, index) {
    this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
    this.#inFlight.set(key, (this.#inFlight.get(key) ?? 0) + 1);
    const finishCapacity = this.#capacity.begin(key, waiter.estimatedTokens);
    const waitedMs = this.#now() - waiter.enqueuedAt;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      finishCapacity();
      const count = (this.#inFlight.get(key) ?? 1) - 1;
      if (count <= 0) this.#inFlight.delete(key);
      else this.#inFlight.set(key, count);
      this.#emit(waiter, "inference.completed", { target: key });
      this.#pump();
    };
    this.#emit(waiter, "inference.started", { target: key, waitedMs, ...(index > 0 ? { preferred: waiter.targets[0] } : {}) });
    if (index > 0) this.#emit(waiter, "inference.target_changed", { from: waiter.targets[0], to: key });
    waiter.resolve({ key, index, waitedMs, release });
  }

  #pump() {
    const now = this.#now();
    let nextWake = Number.POSITIVE_INFINITY;
    for (const waiter of [...this.#waiters]) {
      const waits = waiter.targets.map((key) => this.#waitFor(key, waiter));
      const timed = waits.filter((wait) => wait !== SLOT);
      const soonest = timed.length ? Math.min(...timed) : Number.POSITIVE_INFINITY;
      const slotBound = waits.includes(SLOT);
      const firstWait = waits[0] === SLOT ? 0 : waits[0];
      // The preferred target, unless it is further off than the caller will wait for it.
      let chosen = -1;
      if (waits[0] === 0) chosen = 0;
      else if (now - waiter.enqueuedAt >= waiter.preferFirstWithinMs || (waits[0] !== SLOT && firstWait > waiter.preferFirstWithinMs)) {
        chosen = waits.findIndex((wait) => wait === 0);
      }
      if (chosen !== -1) {
        this.#grant(waiter, waiter.targets[chosen], chosen);
        continue;
      }
      const remaining = waiter.deadline - now;
      if (!slotBound && soonest > remaining) {
        // Capacity will not be back before the caller's deadline: hand the
        // work back with when to resume, instead of holding it or failing it.
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        const reason = timed.every((wait) => wait === Number.POSITIVE_INFINITY) ? "larger_than_allowance" : "capacity";
        this.#emit(waiter, "inference.deferred", { retryInMs: soonest, reason });
        waiter.reject(new WaitingForInferenceError({ retryInMs: soonest, reason, targets: waiter.targets }));
        continue;
      }
      if (!waiter.queuedReported) {
        waiter.queuedReported = true;
        this.#emit(waiter, "inference.queued", { expectedWaitMs: slotBound ? null : soonest, position: this.#waiters.indexOf(waiter) + 1 });
      }
      if (soonest !== Number.POSITIVE_INFINITY) {
        const preferredWake = waits[0] !== SLOT && firstWait <= waiter.preferFirstWithinMs
          ? Math.min(firstWait, waiter.enqueuedAt + waiter.preferFirstWithinMs - now)
          : soonest;
        nextWake = Math.min(nextWake, Math.max(0, preferredWake), slotBound ? Number.POSITIVE_INFINITY : remaining);
      }
    }
    if (nextWake !== Number.POSITIVE_INFINITY) this.#scheduleWake(Math.max(MIN_WAKE_MS, nextWake));
  }

  #scheduleWake(delayMs) {
    const at = this.#now() + delayMs;
    if (this.#wakeAt !== null && this.#wakeAt <= at) return;
    this.#wakeAt = at;
    this.#sleep(delayMs).then(() => {
      if (this.#wakeAt === at) this.#wakeAt = null;
      this.#pump();
    }, () => {
      if (this.#wakeAt === at) this.#wakeAt = null;
    });
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
