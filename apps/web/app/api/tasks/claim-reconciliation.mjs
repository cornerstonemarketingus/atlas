import { EXECUTOR_REPOSITORY_ID } from "./execution-claims.mjs";
import { resultBelongsToTask } from "./runner-result.mjs";
import { verifyExecutionOutcome } from "./execution-outcomes.mjs";
import { saveExecutionOutcome } from "./result-storage.mjs";
import { inspectTaskRequest } from "./request-inspection.mjs";

/** Authority comes from a server-loaded claim, never a caller-supplied run. */
export async function verifySavedExecution(task, claim, token, fetcher = fetch) {
  if (task.repository !== "cornerstonemarketingus/atlas"
    || ![claim.runId, claim.runAttempt].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Unsupported saved executor");
  const identity = { repository: task.repository, run_id: String(claim.runId), run_attempt: String(claim.runAttempt),
    workflow_ref: `${task.repository}/.github/workflows/${task.mode === "coder" ? "atlas-coder.yml" : "atlas-runner.yml"}@refs/heads/main` };
  const response = await fetcher(`https://api.github.com/repos/${task.repository}/actions/runs/${claim.runId}/attempts/${claim.runAttempt}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "atlas-control-plane" },
    redirect: "error", signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Saved run verification unavailable"); }
  const run = await response.json();
  if (String(run?.repository?.id) !== EXECUTOR_REPOSITORY_ID || run.repository.full_name !== task.repository
    || !resultBelongsToTask(identity, task, run)) throw new Error("Saved run identity does not match");
  return { identity, outcome: await verifyExecutionOutcome(identity, task, run, token, fetcher) };
}

/** Observation only: no dispatch, billing, cancellation or execution authority.
 * @param {any} d1
 * @param {{tenantId: number, principal: string}} scope
 * @param {string} key
 * @param {(task: any, claim: {runId: number, runAttempt: number}) => Promise<{identity: any, outcome: any}>} verify
 */
export async function reconcileSavedRequest(d1, scope, key, verify) {
  const saved = await inspectTaskRequest(d1, scope, key);
  if (!saved) return { status: "not-found" };
  if (!saved.task?.execution) return { status: "not-eligible" };
  if (saved.task.execution.outcome) return { status: "observed", request: saved, cached: true };
  const task = await d1.prepare(`SELECT t.task_id AS taskId, t.tenant_id AS tenantId, t.requested_by AS requestedBy,
    t.repository, t.branch, t.mode, t.objective, t.merge_policy AS mergePolicy, t.correlation_id AS correlationId,
    t.execution_provider AS executionProvider, t.dispatch_state AS dispatchState,
    t.conversation_id AS conversationId, t.github_run_id AS githubRunId, c.run_id AS runId, c.run_attempt AS runAttempt
    FROM tasks t JOIN task_execution_claims c ON c.task_id = t.task_id AND c.tenant_id = t.tenant_id AND c.requested_by = t.requested_by
    JOIN task_requests r ON r.correlation_id = t.correlation_id AND r.tenant_id = t.tenant_id AND r.requested_by = t.requested_by
    JOIN conversations v ON v.id = t.conversation_id AND v.tenant_id = t.tenant_id AND v.requested_by = t.requested_by
    WHERE t.task_id = ? AND t.tenant_id = ? AND t.requested_by = ? AND r.request_key = ?
    AND t.execution_provider = 'managed' AND t.dispatch_state IN ('dispatching', 'dispatched', 'unknown')`)
    .bind(saved.task.taskId, scope.tenantId, scope.principal, key).first();
  if (!task) return { status: "not-eligible" };
  const { identity, outcome } = await verify(task, { runId: task.runId, runAttempt: task.runAttempt });
  if (!await saveExecutionOutcome(d1, task, identity, outcome)) return { status: "conflict" };
  return { status: "observed", request: await inspectTaskRequest(d1, scope, key), cached: false };
}
