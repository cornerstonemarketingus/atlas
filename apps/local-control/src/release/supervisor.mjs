/**
 * Crash recovery.
 *
 * Restarting a crashed daemon is easy; the part that needs thought is when to
 * stop. A process that crashes on startup — a corrupt database, a port
 * already bound, a bad configuration — will crash identically forever, and an
 * unconditional restart loop turns one broken install into a machine pinned
 * at 100% CPU with a log nobody reads. So restarts back off, and a crash loop
 * gives up and says why.
 */
export const DEFAULT_POLICY = {
  baseDelayMs: 1_000,
  maximumDelayMs: 60_000,
  // More than this many crashes inside the window means it is not transient.
  crashLoopThreshold: 5,
  crashLoopWindowMs: 60_000,
  // A run that lasted this long counts as healthy and clears the history.
  healthyAfterMs: 120_000,
};

export function createSupervisor({ policy = {}, now = () => Date.now() } = {}) {
  const settings = { ...DEFAULT_POLICY, ...policy };
  let crashes = [];
  let restarts = 0;

  return {
    get restarts() { return restarts; },
    get recentCrashes() { return crashes.length; },

    /**
     * @param startedAtMs when the run that just ended began.
     * @returns what the supervisor should do next, and why.
     */
    recordExit({ code, signal = null, startedAtMs, stderrTail = "" }) {
      const at = now();
      const ranForMs = at - startedAtMs;

      if (code === 0) {
        crashes = [];
        return { action: "stop", reason: "Atlas exited cleanly.", delayMs: 0 };
      }

      // A run that stayed up is evidence the install is fine; whatever
      // happened after two minutes is not a startup failure.
      if (ranForMs >= settings.healthyAfterMs) crashes = [];

      crashes = [...crashes.filter((time) => at - time < settings.crashLoopWindowMs), at];

      if (crashes.length >= settings.crashLoopThreshold) {
        return {
          action: "give-up",
          reason: `Atlas crashed ${crashes.length} times in ${Math.round(settings.crashLoopWindowMs / 1000)} seconds and is not restarting. This is a startup failure, not a transient one.`,
          delayMs: 0,
          diagnostic: summarize(stderrTail),
        };
      }

      restarts += 1;
      return {
        action: "restart",
        reason: `Atlas exited with ${signal ? `signal ${signal}` : `code ${code}`} after ${Math.round(ranForMs / 1000)}s.`,
        delayMs: Math.min(settings.maximumDelayMs, settings.baseDelayMs * 2 ** (crashes.length - 1)),
        diagnostic: summarize(stderrTail),
      };
    },

    /** A crash report an operator can read, with no secrets carried through. */
    crashReport({ code, signal, startedAtMs, stderrTail }) {
      return {
        at: new Date(now()).toISOString(),
        ranForSeconds: Math.round((now() - startedAtMs) / 1000),
        exit: signal ? `signal ${signal}` : `code ${code}`,
        recentCrashes: crashes.length,
        diagnostic: summarize(stderrTail),
      };
    },
  };
}

/** Keeps the tail, and strips anything that looks like a credential. */
function summarize(stderrTail) {
  return String(stderrTail ?? "")
    .split("\n")
    .slice(-20)
    .join("\n")
    .replace(/\b(?:sk|gsk|ghp|github_pat|xox[abps])[-_][A-Za-z0-9_-]{8,}/giu, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]")
    .slice(-4_000);
}
