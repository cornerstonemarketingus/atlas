import { observerHealthContext, projectObserverHealth } from "./observer-health.mjs";
import { TASK_REQUEST_KEY } from "./task-request-contract.mjs";

export const REQUEST_PAGE_SIZE = 20;
const columns = "request_key, correlation_id, state, response_status, substr(response_json, 1, 16385) AS response_json, created_at";

export function decodeRequestCursor(cursor) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== "string" || cursor.length > 256) throw new Error("Invalid cursor");
  const value = JSON.parse(atob(cursor));
  if (!value || typeof value !== "object" || !TASK_REQUEST_KEY.test(value.key)
    || typeof value.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value.createdAt)) throw new Error("Invalid cursor");
  return { key: value.key.toLowerCase(), createdAt: value.createdAt };
}

/** Two matches suffice to detect ambiguity, without loading an entire task history. */
export async function requestTaskMatches(d1, scope, correlationId) {
  const { results } = await d1.prepare(`SELECT t.task_id, t.conversation_id, t.repository, t.branch, substr(t.objective, 1, 240) AS objective, t.execution_provider, t.merge_policy, t.dispatch_state, c.run_id AS claimRunId, c.run_attempt AS claimRunAttempt, c.claimed_at AS claimedAt, c.expires_at AS claimExpiresAt, o.job_id AS outcomeJobId, o.conclusion AS outcomeConclusion, o.completed_at AS outcomeCompletedAt, o.verified_at AS outcomeVerifiedAt, w.enabled AS observationEnabled, w.expires_at AS observationExpiresAt, w.next_check_at AS observationNextCheckAt, l.status AS lastCheckStatus, l.reason AS lastCheckReason, l.started_at AS lastCheckStartedAt,
    (SELECT COUNT(*) FROM task_outcome_observations a WHERE a.task_id = w.task_id AND a.tenant_id = w.tenant_id AND a.requested_by = w.requested_by) AS observationAttempts FROM tasks t LEFT JOIN task_execution_claims c ON c.task_id = t.task_id AND c.tenant_id = t.tenant_id AND c.requested_by = t.requested_by LEFT JOIN task_execution_outcomes o ON o.task_id = c.task_id AND o.tenant_id = c.tenant_id AND o.requested_by = c.requested_by AND o.run_id = c.run_id AND o.run_attempt = c.run_attempt LEFT JOIN task_outcome_watches w ON w.task_id = c.task_id AND w.tenant_id = c.tenant_id AND w.requested_by = c.requested_by AND w.run_id = c.run_id AND w.run_attempt = c.run_attempt LEFT JOIN task_outcome_observations l ON l.task_id = w.task_id AND l.tenant_id = w.tenant_id AND l.requested_by = w.requested_by AND l.run_id = w.run_id AND l.run_attempt = w.run_attempt AND l.slot = (SELECT MAX(x.slot) FROM task_outcome_observations x WHERE x.task_id = w.task_id AND x.tenant_id = w.tenant_id AND x.requested_by = w.requested_by AND x.run_id = w.run_id AND x.run_attempt = w.run_attempt) WHERE t.tenant_id = ? AND t.requested_by = ? AND t.correlation_id = ? ORDER BY t.id LIMIT 2`)
    .bind(scope.tenantId, scope.principal, correlationId).all();
  return results;
}

async function inspectRow(d1, scope, row, context = () => observerHealthContext(d1, scope)) {
  const matches = await requestTaskMatches(d1, scope, row.correlation_id);
  const view = { requestKey: row.request_key, createdAt: row.created_at, receiptState: row.state, outcomeStatus: row.response_status, state: "unconfirmed", task: null };
  if (matches.length > 1) return { ...view, state: "ambiguous" };
  if (matches.length === 1) {
    const task = matches[0];
    const execution = task.claimRunId === null ? null : { runId: task.claimRunId, runAttempt: task.claimRunAttempt, claimedAt: task.claimedAt, expiresAt: task.claimExpiresAt, observation: task.observationEnabled === null ? null : { enabled: task.observationEnabled === 1, expiresAt: new Date(task.observationExpiresAt).toISOString(), attempts: task.observationAttempts, limit: 8 }, outcome: task.outcomeJobId === null ? null : { jobId: task.outcomeJobId, conclusion: task.outcomeConclusion, completedAt: task.outcomeCompletedAt, verifiedAt: task.outcomeVerifiedAt } };
    if (execution?.observation) {
      const { provider, budget, now } = await context();
      execution.observation.health = projectObserverHealth({ enabled: task.observationEnabled, expires_at: task.observationExpiresAt,
        next_check_at: task.observationNextCheckAt, attempts: task.observationAttempts, observed: execution.outcome !== null },
        task.lastCheckStartedAt === null ? null : { status: task.lastCheckStatus, reason: task.lastCheckReason, started_at: task.lastCheckStartedAt }, provider, budget, now);
    }
    return { ...view, state: "task-saved", task: { taskId: task.task_id, conversationId: task.conversation_id, repository: task.repository, branch: task.branch, objective: task.objective, dispatchState: task.dispatch_state, execution } };
  }
  if (row.state !== "completed") return view;
  try {
    const receipt = JSON.parse(row.response_json);
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return view;
    if (receipt.status === "dispatch-rejected" || (row.response_status >= 400 && row.response_status < 500 && row.response_status !== 408)) return { ...view, state: "refused" };
    if (row.response_status >= 200 && row.response_status < 300) return { ...view, state: "acknowledged" };
  } catch { /* Stored bodies are never returned as inspection data. */ }
  return view;
}

export async function inspectTaskRequest(d1, scope, requestKey) {
  const row = await d1.prepare(`SELECT ${columns} FROM task_requests WHERE tenant_id = ? AND requested_by = ? AND request_key = ?`)
    .bind(scope.tenantId, scope.principal, requestKey).first();
  return row ? inspectRow(d1, scope, row) : null;
}

export async function listTaskRequests(d1, scope, cursor = null) {
  const filter = cursor ? " AND (created_at < ? OR (created_at = ? AND request_key < ?))" : "";
  const values = [scope.tenantId, scope.principal, ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.key] : []), REQUEST_PAGE_SIZE + 1];
  const { results } = await d1.prepare(`SELECT ${columns} FROM task_requests WHERE tenant_id = ? AND requested_by = ?${filter} ORDER BY created_at DESC, request_key DESC LIMIT ?`).bind(...values).all();
  const page = results.slice(0, REQUEST_PAGE_SIZE);
  let sharedContext;
  const context = () => sharedContext ??= observerHealthContext(d1, scope);
  const requests = await Promise.all(page.map(row => inspectRow(d1, scope, row, context)));
  const last = page.at(-1);
  const nextCursor = results.length > REQUEST_PAGE_SIZE ? btoa(JSON.stringify({ key: last.request_key, createdAt: last.created_at })) : null;
  return { requests, nextCursor };
}
