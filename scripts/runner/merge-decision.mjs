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

/**
 * Whether a coder pull request may be merged without a person, whatever the
 * repository's merge policy says (SECURITY-REVIEW SEC-7). Only a change whose
 * baseline/post-change verification *passed* qualifies: "regressed" is known
 * to be broken, and "unverified"/"inconclusive" mean Atlas has no evidence the
 * change works — both stay open for review instead of merging on hope.
 *
 * @returns {{ allowed: boolean, reason: string }}
 */
export function autoMergeAllowed(policy, verification) {
  if (policy !== "none" && policy !== "ci-gated") return { allowed: false, reason: "The merge policy is manual." };
  const status = verification?.status ?? "unverified";
  if (status === "passed") return { allowed: true, reason: "Verification passed." };
  if (status === "regressed") {
    return { allowed: false, reason: `verification found ${verification.newFailures?.length ?? 0} failure(s) this change introduced. ${verification.message ?? ""}`.trim() };
  }
  return { allowed: false, reason: `verification did not pass (status: ${status}), so there is no evidence the change works.` };
}
