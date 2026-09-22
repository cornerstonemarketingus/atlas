export function statusLine(task) {
  if (task.status === "succeeded") {
    if (task.mode === "coder") return task.pullRequest?.url
      ? "The run finished and a pull request is available. Review its changes and validation evidence."
      : "The run finished, but Atlas has no pull request to show. Check the reported results and run log.";
    return "The run finished. Reported findings appear in this conversation when delivery completes.";
  }
  if (task.status === "failed") return "The run failed. Check the reported results and run log for the failing step.";
  if (task.status === "timed_out") return "The run hit its time limit and was stopped.";
  if (task.status === "cancelled") return "The run was cancelled.";
  if (task.status === "skipped") return "The run was skipped.";
  if (task.status === "action_required") return "The run is waiting for action in GitHub.";
  if (task.status === "running") return "The runner is working. Findings will appear here when it reports back.";
  if (task.status === "queued") return "Queued on GitHub Actions, waiting for a runner.";
  return "Sent to the runner. Waiting for GitHub to report the run.";
}
