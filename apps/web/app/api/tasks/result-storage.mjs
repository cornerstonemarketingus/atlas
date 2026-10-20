/** Persist a report only while the saved task, conversation and executor agree.
 * Claim expiry ends execution authority, not authority to deliver a late report.
 * A report never releases a claim or authorizes another execution.
 * @param {any} d1
 * @param {any} task
 * @param {any} identity
 * @param {string | null} summary
 * @param {string} [now]
 * @param {{runId: number, runAttempt: number, jobId: number, headSha: string, conclusion: string, completedAt: string} | null} [outcome]
 */
export async function saveRunnerResult(d1, task, identity, summary, now = new Date().toISOString(), outcome = null) {
  const id = `result:${task.taskId}:${identity.run_id}:${identity.run_attempt}`;
  if (outcome && (outcome.runId !== Number(identity.run_id) || outcome.runAttempt !== Number(identity.run_attempt))) return false;
  let guard = `SELECT 1 FROM tasks t JOIN conversations c ON c.id = t.conversation_id
    AND c.requested_by = t.requested_by AND c.tenant_id IS t.tenant_id
    WHERE t.task_id = ? AND t.requested_by = ? AND t.tenant_id IS ?
    AND t.conversation_id = ? AND t.repository = ? AND t.mode = ?
    AND t.branch = ? AND t.objective = ? AND t.merge_policy = ?
    AND t.execution_provider = 'managed' AND t.dispatch_state = ?
    AND t.correlation_id IS ? AND (t.github_run_id IS NULL OR t.github_run_id = ?)
    AND (EXISTS (SELECT 1 FROM task_execution_claims x WHERE x.task_id = t.task_id
      AND x.tenant_id = t.tenant_id AND x.requested_by = t.requested_by
      AND x.run_id = ? AND x.run_attempt = ?)
      OR (t.dispatch_state = 'legacy' AND NOT EXISTS
        (SELECT 1 FROM task_execution_claims x WHERE x.task_id = t.task_id)))`;
  const bindings = [task.taskId, task.requestedBy, task.tenantId, task.conversationId,
    task.repository, task.mode, task.branch, task.objective, task.mergePolicy, task.dispatchState, task.correlationId,
    Number(identity.run_id), Number(identity.run_id), Number(identity.run_attempt)];
  if (outcome) {
    // First receipt is immutable. A conflicting observation cannot partially
    // replace the report, receipt or conversation timestamp.
    guard += ` AND EXISTS (SELECT 1 FROM task_execution_claims x WHERE x.task_id = t.task_id
      AND x.tenant_id = t.tenant_id AND x.requested_by = t.requested_by AND x.run_id = ? AND x.run_attempt = ?)
      AND NOT EXISTS (SELECT 1 FROM task_execution_outcomes o WHERE o.task_id = t.task_id
        AND (o.tenant_id != t.tenant_id OR o.requested_by != t.requested_by OR o.run_id != ? OR o.run_attempt != ?
          OR o.job_id != ? OR o.head_sha != ? OR o.conclusion != ? OR o.completed_at != ?))`;
    bindings.push(outcome.runId, outcome.runAttempt, outcome.runId, outcome.runAttempt,
      outcome.jobId, outcome.headSha, outcome.conclusion, outcome.completedAt);
  }
  const statements = [];
  if (summary !== null) statements.push(
    d1.prepare(`INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at)
      SELECT ?, ?, ?, ?, 'result', 'Runner results received', ?, ? WHERE EXISTS (${guard})
      ON CONFLICT(id) DO NOTHING`).bind(id, task.conversationId, task.taskId, task.requestedBy, summary, now, ...bindings),
    d1.prepare(`INSERT INTO conversation_messages (id, conversation_id, requested_by, role, content, created_at)
      SELECT ?, ?, ?, 'assistant', ?, ? WHERE EXISTS (${guard}) ON CONFLICT(id) DO NOTHING`)
      .bind(id, task.conversationId, task.requestedBy, summary, now, ...bindings),
  );
  const updateIndex = statements.length;
  statements.push(
    d1.prepare(`UPDATE tasks SET github_run_id = ? WHERE task_id = ? AND EXISTS (${guard})`)
      .bind(Number(identity.run_id), task.taskId, ...bindings),
    d1.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ? AND EXISTS (${guard})`)
      .bind(now, task.conversationId, ...bindings),
  );
  if (outcome) {
    statements.push(d1.prepare(`INSERT INTO task_execution_outcomes
      (task_id, tenant_id, requested_by, run_id, run_attempt, job_id, head_sha, conclusion, completed_at, verified_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard}) ON CONFLICT(task_id) DO NOTHING`)
      .bind(task.taskId, task.tenantId, task.requestedBy, outcome.runId, outcome.runAttempt,
        outcome.jobId, outcome.headSha, outcome.conclusion, outcome.completedAt, now, ...bindings));
    statements.push(d1.prepare(`INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at)
      SELECT ?, ?, ?, ?, 'execution-outcome', 'Execution job outcome verified', ?, ? WHERE EXISTS (${guard}) ON CONFLICT(id) DO NOTHING`)
      .bind(`outcome:${task.taskId}:${identity.run_id}:${identity.run_attempt}`, task.conversationId, task.taskId,
        task.requestedBy, `GitHub execution job ${outcome.jobId}: ${outcome.conclusion}. This is not proof of code validation and does not authorize retry.`, now, ...bindings));
  }
  const results = await d1.batch(statements);
  if (results.some(result => result.success === false)) throw new Error("Result persistence unavailable");
  return results[updateIndex]?.meta?.changes === 1;
}

/** Reconciliation records evidence only; it never fabricates an agent message. */
export function saveExecutionOutcome(d1, task, identity, outcome, now = new Date().toISOString()) {
  if (!outcome) return false;
  return saveRunnerResult(d1, task, identity, null, now, outcome);
}
