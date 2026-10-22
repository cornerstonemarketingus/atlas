/** Leave time for the CLI to cancel, checkpoint and return before forced cleanup. */
export function coderExecutionPolicy(environment = process.env) {
  const integer = (name, fallback, minimum, maximum) => {
    const input = environment[name]?.trim();
    if (!input) return fallback;
    const value = Number(input);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return value;
  };
  const timeoutMs = integer("ATLAS_CODER_TIMEOUT_MS", 900_000, 5_000, 2_700_000);
  if (environment.ATLAS_JOB_TIMEOUT_MINUTES?.trim()) {
    const jobMinutes = integer("ATLAS_JOB_TIMEOUT_MINUTES", 25, 11, 60);
    // Setup, PR creation/check polling and artifact upload share the job budget.
    if (timeoutMs > (jobMinutes - 10) * 60_000) {
      throw new RangeError("ATLAS_CODER_TIMEOUT_MS must leave at least 10 minutes within ATLAS_JOB_TIMEOUT_MINUTES for setup, PR checks and recovery artifacts.");
    }
  }
  return {
    timeoutMs,
    executionTimeoutMs: timeoutMs - Math.min(30_000, Math.floor(timeoutMs / 5)),
    checkpointIntervalMs: integer("ATLAS_CODER_CHECKPOINT_INTERVAL_MS", 15_000, 1_000, 60_000),
  };
}
