const conclusions = new Set(["success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "stale", "startup_failure"]);
const positive = value => Number.isSafeInteger(value) && value > 0;

/** Only the completed execution job of the exact authenticated attempt is evidence.
 * The reporting job keeps the overall workflow in progress and is not execution.
 */
export function executionOutcome(identity, task, run, page, now = Date.now()) {
  if (!positive(Number(identity.run_id)) || !positive(Number(identity.run_attempt))
    || !Array.isArray(page?.jobs) || !Number.isInteger(page.total_count)
    || page.total_count < 1 || page.total_count > 100 || page.jobs.length !== page.total_count) throw new Error("Incomplete execution job evidence");
  const jobs = page.jobs.filter(job => job?.name === "run");
  if (jobs.length !== 1) throw new Error("Ambiguous execution job evidence");
  const job = jobs[0];
  const completed = Date.parse(job.completed_at);
  if (!positive(job.id) || String(job.run_id) !== String(identity.run_id)
    || (job.run_attempt !== undefined && String(job.run_attempt) !== String(identity.run_attempt))
    || job.status !== "completed" || !conclusions.has(job.conclusion)
    || job.head_branch !== "main" || job.workflow_name !== (task.mode === "coder" ? "Atlas Coder" : "Atlas Runner")
    || !/^[0-9a-f]{40}$/.test(run.head_sha ?? "") || job.head_sha !== run.head_sha
    || typeof job.completed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(job.completed_at)
    || !Number.isFinite(completed) || completed > now + 60000) throw new Error("Unverified execution job evidence");
  return { runId: Number(identity.run_id), runAttempt: Number(identity.run_attempt), jobId: job.id,
    headSha: job.head_sha, conclusion: job.conclusion, completedAt: new Date(completed).toISOString() };
}

export async function verifyExecutionOutcome(identity, task, run, token, fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${task.repository}/actions/runs/${identity.run_id}/attempts/${identity.run_attempt}/jobs?per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "atlas-control-plane" },
    redirect: "error", signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Execution job verification unavailable"); }
  return executionOutcome(identity, task, run, await response.json());
}
