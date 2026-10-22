/** One cooperative bound shared by model calls, tools, validation and repair passes. */
export class ExecutionDeadline {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout> | undefined;
  public readonly expiresAt: number | null;

  public constructor(timeoutMs?: number) {
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_700_000)) {
      throw new RangeError("Execution deadline must be an integer between 1 and 2700000 milliseconds.");
    }
    this.expiresAt = timeoutMs === undefined ? null : Date.now() + timeoutMs;
    if (timeoutMs !== undefined) {
      this.#timer = setTimeout(() => this.#controller.abort(new Error("EXECUTION_DEADLINE_EXCEEDED")), timeoutMs);
      this.#timer.unref();
    }
  }

  public get signal(): AbortSignal { return this.#controller.signal; }
  public get expired(): boolean { return this.#controller.signal.aborted; }
  public dispose(): void { clearTimeout(this.#timer); }
}
