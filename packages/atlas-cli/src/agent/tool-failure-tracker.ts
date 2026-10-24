/**
 * Notices a coding run that keeps failing the same way.
 *
 * A failed tool call is information the model should get back, so the agent
 * returns it and carries on. Without a memory of what already failed, though,
 * a model that cannot fix a call just sends it again until the turn budget is
 * gone and nothing is left to show for it. This keeps that memory, in two
 * bounded steps so the first repeat is a chance to change course and the next
 * is the end of the loop:
 *
 *  - the same tool with the same arguments failing the same way a second time
 *    gets a specific correction;
 *  - a third time, or too many failures in a row with no success between them,
 *    stops the run as blocked, with the work done so far intact.
 *
 * Arguments are compared by the agent's per-run keyed digest, so nothing
 * sensitive is held here. It never retries or executes anything itself.
 */
export interface ToolFailure {
  readonly tool: string;
  readonly argumentsDigest: string;
  readonly errorCode: string;
}

export type ToolFailureVerdict =
  | { readonly action: "continue"; readonly guidance: string }
  | { readonly action: "correct"; readonly guidance: string; readonly occurrences: number }
  | { readonly action: "stop"; readonly reason: "repeated-identical-failure" | "no-progress"; readonly message: string };

export interface ToolFailureLimits {
  /** Identical failures (same tool, arguments and code) tolerated before the run is stopped. Default 3. */
  readonly identicalFailures: number;
  /** Failed calls in a row, with no success between, tolerated before the run is stopped. Default 5. */
  readonly consecutiveFailures: number;
}

export const DEFAULT_TOOL_FAILURE_LIMITS: ToolFailureLimits = Object.freeze({ identicalFailures: 3, consecutiveFailures: 5 });

const GUIDANCE: Readonly<Record<string, string>> = {
  INVALID_TOOL_INPUT: "The arguments did not match the tool's schema. Use exactly the listed fields and types.",
  TOOL_NOT_FOUND: "That tool is not offered. Call one of the available tools exactly as named.",
};
const GENERIC_GUIDANCE = "Do not send the same call again. Read the current file contents with repository.read_source, then retry with a smaller edit that matches them exactly, or choose a different approach.";

export class ToolFailureTracker {
  readonly #limits: ToolFailureLimits;
  readonly #identical = new Map<string, number>();
  #consecutive = 0;

  public constructor(limits: Partial<ToolFailureLimits> = {}) {
    this.#limits = { ...DEFAULT_TOOL_FAILURE_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 2) throw new RangeError(`${name} must be an integer of at least 2.`);
    }
  }

  public recordSuccess(): void {
    this.#consecutive = 0;
  }

  public recordFailure(failure: ToolFailure): ToolFailureVerdict {
    const key = `${failure.tool}\u0000${failure.argumentsDigest}\u0000${failure.errorCode}`;
    const occurrences = (this.#identical.get(key) ?? 0) + 1;
    this.#identical.set(key, occurrences);
    this.#consecutive += 1;

    if (occurrences >= this.#limits.identicalFailures) {
      return {
        action: "stop",
        reason: "repeated-identical-failure",
        message: `Repeated tool failure: ${failure.tool} failed ${occurrences} times with the same arguments (${failure.errorCode}). Stopped instead of retrying the same call.`,
      };
    }
    if (this.#consecutive >= this.#limits.consecutiveFailures) {
      return {
        action: "stop",
        reason: "no-progress",
        message: `No progress: ${this.#consecutive} tool calls in a row failed (latest: ${failure.tool}, ${failure.errorCode}). Stopped instead of spending the remaining turns.`,
      };
    }
    const guidance = GUIDANCE[failure.errorCode] ?? GENERIC_GUIDANCE;
    if (occurrences >= 2) {
      return {
        action: "correct",
        occurrences,
        guidance: `This exact call has now failed ${occurrences} times with ${failure.errorCode}. ${guidance} One more identical failure ends this run.`,
      };
    }
    return { action: "continue", guidance };
  }
}
