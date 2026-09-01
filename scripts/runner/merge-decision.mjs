const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]);
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Decides what to do with a coder-opened pull request given its merge
 * policy and the check-runs currently reported for its head commit.
 * `checkRuns` is `{ status: "queued"|"in_progress"|"completed", conclusion: string|null }[]`
 * as returned by GitHub's list-check-runs-for-a-ref API.
 *
 * Returns one of:
 * - "merge-now": policy allows it outright ("none"), or every check that
 *   has reported for "ci-gated" completed successfully.
 * - "wait": ci-gated, and either no checks have reported yet or some are
 *   still running — worth polling again. The caller is responsible for
 *   giving up after its own timeout; this function has no notion of
 *   elapsed time, so a repository with no CI configured at all would
 *   otherwise wait forever.
 * - "hold": leave the PR open for a human — "manual" policy, or a
 *   ci-gated check actually failed.
 */
export function decideMergeAction(policy, checkRuns) {
  if (policy === "none") return "merge-now";
  if (policy !== "ci-gated") return "hold";

  if (checkRuns.length === 0) return "wait";
  if (checkRuns.some((run) => run.status !== "completed")) return "wait";
  if (checkRuns.some((run) => FAILURE_CONCLUSIONS.has(run.conclusion))) return "hold";
  if (checkRuns.every((run) => PASSING_CONCLUSIONS.has(run.conclusion))) return "merge-now";
  // A completed run with some other conclusion (e.g. "startup_failure") —
  // don't guess; treat anything unrecognized as not-passing.
  return "hold";
}
