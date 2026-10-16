/** Persist a report only while the saved task, conversation and executor agree.
 * Claim expiry ends execution authority, not authority to deliver a late report.
 * A report never releases a claim or authorizes another execution.
 */
export async function saveRunnerResult(d1, task, identity, summary, now = new Date().toISOString()) {
  const id = `result:${task.taskId}:${identity.run_id}:${identity.run_attempt}`;
  const guard = `SELECT 1 FROM tasks t JOIN conversations c ON c.id = t.conversation_id
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
  const results = await d1.batch([
    d1.prepare(`INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at)
      SELECT ?, ?, ?, ?, 'result', 'Runner results received', ?, ? WHERE EXISTS (${guard})
      ON CONFLICT(id) DO NOTHING`).bind(id, task.conversationId, task.taskId, task.requestedBy, summary, now, ...bindings),
    d1.prepare(`INSERT INTO conversation_messages (id, conversation_id, requested_by, role, content, created_at)
      SELECT ?, ?, ?, 'assistant', ?, ? WHERE EXISTS (${guard}) ON CONFLICT(id) DO NOTHING`)
      .bind(id, task.conversationId, task.requestedBy, summary, now, ...bindings),
    d1.prepare(`UPDATE tasks SET github_run_id = ? WHERE task_id = ? AND EXISTS (${guard})`)
      .bind(Number(identity.run_id), task.taskId, ...bindings),
    d1.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ? AND EXISTS (${guard})`)
      .bind(now, task.conversationId, ...bindings),
  ]);
  if (results.some(result => result.success === false)) throw new Error("Result persistence unavailable");
  return results[2]?.meta?.changes === 1;
}
