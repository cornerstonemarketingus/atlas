export class RunCancelledError extends Error {
  constructor(reason = "cancelled") {
    super(`Run was cancelled (${reason}).`);
    this.name = "RunCancelledError";
    this.code = "RUN_CANCELLED";
    this.reason = reason;
  }
}

/**
 * Cooperative pause/cancel for one run.
 *
 * Cancellation is immediate and abortive — the AbortSignal reaches the model
 * request and any child process, so generation stops rather than finishing
 * into a discarded buffer. Pause is deliberately *not* abortive: it suspends
 * the run between steps so a half-written file or a half-finished model call
 * is never the resume point. That is why the executor must reach a
 * `checkpoint()` before a pause takes effect, and why a pause is reported as
 * requested until it does.
 */
export class RunControl {
  #paused = false;
  #cancelled = null;
  #controller = new AbortController();
  #waiters = [];
  #onPauseReached;

  constructor({ onPauseReached = () => {} } = {}) {
    this.#onPauseReached = onPauseReached;
  }

  get signal() { return this.#controller.signal; }
  get paused() { return this.#paused; }
  get cancelled() { return this.#cancelled !== null; }
  get cancelReason() { return this.#cancelled; }

  pause() { this.#paused = true; }

  resume() {
    this.#paused = false;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter();
  }

  cancel(reason = "cancelled") {
    if (this.#cancelled) return;
    this.#cancelled = reason;
    this.#controller.abort(new RunCancelledError(reason));
    this.resume();
  }

  /** Executors await this between steps; it throws when the run is cancelled. */
  async checkpoint() {
    if (this.#cancelled) throw new RunCancelledError(this.#cancelled);
    if (!this.#paused) return;
    this.#onPauseReached();
    while (this.#paused && !this.#cancelled) {
      await new Promise((resolve) => this.#waiters.push(resolve));
    }
    if (this.#cancelled) throw new RunCancelledError(this.#cancelled);
  }
}
