import { TASK_REQUEST_KEY } from "./task-request-contract.mjs";
import { isCorrelationId } from "./correlation.mjs";
import { resultBelongsToTask, verifyRunnerIdentity } from "./runner-result.mjs";

export const CLAIM_AUDIENCE = "atlas-task-execution";
// Immutable ID verified from GitHub; the existing hosted executor also restricts this repository.
export const EXECUTOR_REPOSITORY_ID = "1337761549";
export const CLAIM_LEASE_MS = 6 * 60 * 60 * 1000;
const modes = new Set(["inspect", "debug", "coder"]);
const policies = new Set(["manual", "ci-gated", "none"]);

export async function verifyClaimIdentity(token, keySet) {
  const identity = await verifyRunnerIdentity(token, keySet, { audience: CLAIM_AUDIENCE });
  if (identity.repository !== "cornerstonemarketingus/atlas" || String(identity.repository_id) !== EXECUTOR_REPOSITORY_ID
    || !["atlas-coder.yml", "atlas-runner.yml"].some(workflow => identity.workflow_ref === `cornerstonemarketingus/atlas/.github/workflows/${workflow}@refs/heads/main`)
    || ![identity.run_id, identity.run_attempt].every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0)) throw new Error("Untrusted claim identity");
  return identity;
}

export function validateExecutionClaim(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !TASK_REQUEST_KEY.test(body.taskId)
    || body.repository !== "cornerstonemarketingus/atlas" || !modes.has(body.mode)
    || typeof body.branch !== "string" || !body.branch || body.branch.length > 255
    || typeof body.objective !== "string" || !body.objective.trim() || new TextEncoder().encode(body.objective).byteLength > 4096
    || !policies.has(body.mergePolicy) || !isCorrelationId(body.correlationId)) throw new Error("Invalid execution claim");
  const { taskId, repository, mode, branch, objective, mergePolicy, correlationId } = body;
  return { taskId: taskId.toLowerCase(), repository, mode, branch, objective, mergePolicy, correlationId };
}

export function claimMatchesTask(body, task) {
  return task?.executionProvider === "managed" && task.tenantId !== null && task.conversationId
    && ["dispatching", "dispatched", "unknown"].includes(task.dispatchState)
    && ["taskId", "repository", "mode", "branch", "objective", "mergePolicy", "correlationId"].every(key => body[key] === task[key]);
}

export function claimRunMatches(identity, task, run) {
  return String(run?.repository?.id) === EXECUTOR_REPOSITORY_ID
    && run?.repository?.full_name === task.repository && run?.status === "in_progress"
    && resultBelongsToTask(identity, task, run);
}

/** Atomic immutable ownership. Expiration never releases the slot to another run. */
export async function grantTaskExecution(d1, task, identity, now = new Date()) {
  const runId = Number(identity.run_id); const runAttempt = Number(identity.run_attempt);
  const claimedAt = now.toISOString(); const expiresAt = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  const scope = [task.taskId, task.tenantId, task.requestedBy];
  const snapshot = [task.repository, task.branch, task.mode, task.objective, task.mergePolicy, task.correlationId, task.conversationId];
  const result = await d1.batch([
    d1.prepare("INSERT INTO task_execution_claims (task_id, tenant_id, requested_by, run_id, run_attempt, claimed_at, expires_at) SELECT task_id, tenant_id, requested_by, ?, ?, ?, ? FROM tasks WHERE task_id = ? AND tenant_id = ? AND requested_by = ? AND execution_provider = 'managed' AND dispatch_state IN ('dispatching', 'dispatched', 'unknown') AND (github_run_id IS NULL OR github_run_id = ?) AND repository = ? AND branch = ? AND mode = ? AND objective = ? AND merge_policy = ? AND correlation_id = ? AND conversation_id = ? AND EXISTS (SELECT 1 FROM conversations WHERE conversations.id = tasks.conversation_id AND conversations.tenant_id = tasks.tenant_id AND conversations.requested_by = tasks.requested_by) ON CONFLICT(task_id) DO NOTHING")
      .bind(runId, runAttempt, claimedAt, expiresAt, ...scope, runId, ...snapshot),
    d1.prepare("UPDATE tasks SET github_run_id = ?, dispatch_state = 'dispatched' WHERE task_id = ? AND tenant_id = ? AND requested_by = ? AND (github_run_id IS NULL OR github_run_id = ?) AND repository = ? AND branch = ? AND mode = ? AND objective = ? AND merge_policy = ? AND correlation_id = ? AND conversation_id = ? AND execution_provider = 'managed' AND dispatch_state IN ('dispatching', 'dispatched', 'unknown') AND EXISTS (SELECT 1 FROM conversations WHERE conversations.id = tasks.conversation_id AND conversations.tenant_id = tasks.tenant_id AND conversations.requested_by = tasks.requested_by) AND EXISTS (SELECT 1 FROM task_execution_claims c WHERE c.task_id = tasks.task_id AND c.tenant_id = tasks.tenant_id AND c.requested_by = tasks.requested_by AND c.run_id = ? AND c.run_attempt = ? AND c.expires_at > ?)")
      .bind(runId, ...scope, runId, ...snapshot, runId, runAttempt, claimedAt),
    d1.prepare("INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at) SELECT ?, t.conversation_id, t.task_id, t.requested_by, 'execution', 'Cloud execution claimed', 'A verified cloud run claimed this task before coding tools started.', ? FROM tasks t JOIN task_execution_claims c ON c.task_id = t.task_id AND c.tenant_id = t.tenant_id AND c.requested_by = t.requested_by WHERE t.task_id = ? AND t.tenant_id = ? AND t.requested_by = ? AND c.run_id = ? AND c.run_attempt = ? AND c.expires_at > ? AND t.repository = ? AND t.branch = ? AND t.mode = ? AND t.objective = ? AND t.merge_policy = ? AND t.correlation_id = ? AND t.conversation_id = ? AND EXISTS (SELECT 1 FROM conversations v WHERE v.id = t.conversation_id AND v.tenant_id = t.tenant_id AND v.requested_by = t.requested_by) ON CONFLICT(id) DO NOTHING")
      .bind(`execution-claim:${task.taskId}`, claimedAt, ...scope, runId, runAttempt, claimedAt, ...snapshot),
  ]);
  if (result.some(item => item.success === false)) throw new Error("Claim storage unavailable");
  const saved = await d1.prepare("SELECT run_id, run_attempt, expires_at FROM task_execution_claims WHERE task_id = ? AND tenant_id = ? AND requested_by = ?").bind(...scope).first();
  if (!saved || saved.run_id !== runId || saved.run_attempt !== runAttempt || saved.expires_at <= claimedAt || result[1]?.meta?.changes !== 1) return null;
  return { granted: true, taskId: task.taskId, runId, runAttempt, expiresAt: saved.expires_at, replayed: result[0]?.meta?.changes === 0 };
}
