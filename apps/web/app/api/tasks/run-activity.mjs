import { taskIdFromRunName } from "./run-status.mjs";

/**
 * Live activity for one run, shaped for the chat timeline.
 *
 * The runner's GitHub Actions steps are the only live signal a hosted run
 * has while it works, so they are what the conversation shows as Atlas's
 * steps (the way a coding agent shows what it is doing). Plumbing steps are
 * dropped and the rest get plain names.
 */

const FRIENDLY = new Map([
  ["Check the Actions minutes budget", "Checking the run budget"],
  ["Validate dispatch inputs", "Checking the request"],
  ["Check out trusted runner policy", "Loading Atlas's safety rules"],
  ["Check out requested branch as untrusted data", "Checking out your code"],
  ["Build trusted Atlas CLI", "Preparing Atlas"],
  ["Build trusted credential scanner", "Preparing the secret scanner"],
  ["Install target validation dependencies", "Installing your project's dependencies"],
  ["Start a self-hosted model server", "Starting the model"],
  ["Run Atlas task", "Working on it: reading, changing and testing code"],
  ["Open pull request for coder changes", "Opening the pull request"],
  ["Deliver redacted findings", "Posting the findings"],
  ["Write run summary", "Writing the summary"],
]);

const NOISE = [/^Set up job$/u, /^Complete job$/u, /^Post /u, /^Set up Node/u, /^Upload bounded task artifacts$/u, /^Download result data$/u, /^Run actions\//u];

/** The run belongs to this task only when its run name carries the task id. */
export function runBelongsToTask(run, taskId) {
  const named = taskIdFromRunName(run?.name ?? run?.display_title ?? null);
  return named !== null && named === String(taskId).toLowerCase();
}

function stepState(step) {
  if (step.status === "completed") {
    if (step.conclusion === "success") return "done";
    if (step.conclusion === "skipped") return "skipped";
    return "failed";
  }
  return step.status === "in_progress" ? "running" : "pending";
}

/**
 * @param {{ status?: string, conclusion?: string|null, html_url?: string }} run
 * @param {{ jobs?: { steps?: { name: string, status: string, conclusion: string|null, started_at?: string|null, completed_at?: string|null }[] }[] }} jobsPayload
 */
export function activityFromRun(run, jobsPayload) {
  const steps = [];
  for (const job of jobsPayload?.jobs ?? []) {
    for (const step of job.steps ?? []) {
      if (typeof step?.name !== "string" || NOISE.some((pattern) => pattern.test(step.name))) continue;
      const state = stepState(step);
      if (state === "skipped") continue;
      steps.push({
        label: FRIENDLY.get(step.name) ?? step.name,
        state,
        startedAt: typeof step.started_at === "string" ? step.started_at : null,
        completedAt: typeof step.completed_at === "string" ? step.completed_at : null,
      });
    }
  }
  return {
    status: typeof run?.status === "string" ? run.status : null,
    conclusion: typeof run?.conclusion === "string" ? run.conclusion : null,
    url: typeof run?.html_url === "string" ? run.html_url : null,
    steps,
  };
}
