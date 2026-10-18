import { taskIdFromRunName } from "./run-status.mjs";

/** One D1 transaction; no external action can precede the saved task. */
export async function persistTaskIntent(d1, data) {
  const { taskId, tenantId, account, task, conversationId, mergePolicy, executionProvider, correlationId } = data;
  const now = new Date().toISOString();
  const result = await d1.batch([
    d1.prepare("INSERT INTO conversations (id, tenant_id, requested_by, title, repository, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, repository = excluded.repository, branch = excluded.branch WHERE conversations.tenant_id = excluded.tenant_id AND conversations.requested_by = excluded.requested_by")
      .bind(conversationId, tenantId, account.userId, task.objective.slice(0, 72), task.repository, task.branch, now, now),
    d1.prepare("INSERT INTO tasks (task_id, tenant_id, user_id, requested_by, repository, branch, mode, objective, merge_policy, conversation_id, execution_provider, correlation_id, created_at, dispatch_state) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, id, ?, ?, ?, 'recorded' FROM conversations WHERE id = ? AND tenant_id = ? AND requested_by = ?")
      .bind(taskId, tenantId, account.dbUserId, account.userId, task.repository, task.branch, task.mode, task.objective, mergePolicy, executionProvider, correlationId, now, conversationId, tenantId, account.userId),
    d1.prepare("INSERT INTO conversation_messages (id, conversation_id, requested_by, role, content, created_at) SELECT ?, conversation_id, requested_by, 'user', objective, ? FROM tasks WHERE task_id = ? AND tenant_id = ? AND requested_by = ?")
      .bind(`request:${taskId}`, now, taskId, tenantId, account.userId),
    d1.prepare("INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at) SELECT ?, conversation_id, task_id, requested_by, 'queued', 'Request saved', 'Atlas saved the request before preparing its cloud run.', ? FROM tasks WHERE task_id = ? AND tenant_id = ? AND requested_by = ?")
      .bind(`request:${taskId}`, now, taskId, tenantId, account.userId),
  ]);
  if (result.some(item => item.success === false) || result[1]?.meta?.changes !== 1) throw new Error("Task intent unavailable");
}

async function recordState(d1, data, state, { begin = false } = {}) {
  const label = { dispatching: "Dispatch requested", dispatched: "Cloud dispatch accepted", unknown: "Cloud dispatch unconfirmed", rejected: "Cloud dispatch rejected" }[state];
  const detail = { dispatching: "Atlas is asking the executor to start this saved task.", dispatched: "The executor accepted the request; live progress confirms execution.", unknown: "The request is saved. Check the existing run before starting another task.", rejected: "The executor refused this request. No successful dispatch is inferred." }[state];
  const result = await d1.batch([
    d1.prepare(`UPDATE tasks SET dispatch_state = ? WHERE task_id = ? AND tenant_id = ? AND requested_by = ? AND dispatch_state ${begin ? "= 'recorded'" : "IN ('dispatching', 'unknown')"}`)
      .bind(state, data.taskId, data.tenantId, data.account.userId),
    d1.prepare("INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at) SELECT ?, conversation_id, task_id, requested_by, 'dispatch', ?, ?, ? FROM tasks WHERE task_id = ? AND tenant_id = ? AND requested_by = ? AND dispatch_state = ? ON CONFLICT(id) DO NOTHING")
      .bind(`dispatch:${data.taskId}:${state}`, label, detail, new Date().toISOString(), data.taskId, data.tenantId, data.account.userId, state),
  ]);
  if (result.some(item => item.success === false) || result[0]?.meta?.changes !== 1) throw new Error("Dispatch state unavailable");
}

/** A single external attempt. An uncertain outcome is never replayed. */
export async function dispatchSavedTask(d1, data, send) {
  await persistTaskIntent(d1, data);
  await recordState(d1, data, "dispatching", { begin: true });
  let response;
  try { response = await send(); }
  catch {
    try { await recordState(d1, data, "unknown"); } catch { /* durable dispatching intent remains */ }
    return { state: "unknown" };
  }
  const state = response.ok ? "dispatched" : response.status >= 500 ? "unknown" : "rejected";
  try { await response.body?.cancel(); } catch { /* provider bodies are never exposed */ }
  try { await recordState(d1, data, state); } catch { /* persisted intent still permits read-only reconciliation */ }
  return { state, response };
}

/** Reconcile new requests using exact run identity, never the legacy time heuristic. */
export function reconcileDispatchRuns(rows, runs, workflow) {
  const assignments = [];
  for (const row of rows) {
    if (!["dispatching", "dispatched", "unknown"].includes(row.dispatchState) || row.githubRunId !== null) continue;
    const candidates = runs.filter(run => Number.isSafeInteger(run?.id) && run.id > 0
      && run.event === "workflow_dispatch" && run.head_branch === "main"
      && run.repository?.full_name?.toLowerCase() === row.repository.toLowerCase()
      && (run.path === `.github/workflows/${workflow}` || String(run.workflow_id) === workflow)
      && taskIdFromRunName(run.display_title ?? run.name) === row.taskId);
    if (candidates.length === 1) assignments.push({ taskId: row.taskId, runId: candidates[0].id });
  }
  return assignments;
}

export function savedDispatchStatus(row, run) {
  if (run || row.githubRunId !== null || row.dispatchState === "legacy") return null;
  if (row.dispatchState === "rejected") return "failed";
  if (row.dispatchState === "recorded") return "dispatch-pending";
  if (["dispatching", "unknown"].includes(row.dispatchState)) return "dispatch-unknown";
  return null;
}

/** Persist an exact recovery match and its receipt in the same transaction. */
export async function saveReconciledDispatch(d1, { taskId, runId, tenantId, principal }) {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("Invalid run identity");
  const result = await d1.batch([
    d1.prepare("UPDATE tasks SET github_run_id = ?, dispatch_state = 'dispatched' WHERE task_id = ? AND tenant_id = ? AND requested_by = ? AND execution_provider = 'managed' AND dispatch_state IN ('dispatching', 'dispatched', 'unknown') AND (github_run_id IS NULL OR github_run_id = ?)")
      .bind(runId, taskId, tenantId, principal, runId),
    d1.prepare("INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at) SELECT ?, conversation_id, task_id, requested_by, 'dispatch', 'Cloud run identified', 'Atlas identified the existing cloud run without repeating dispatch.', ? FROM tasks WHERE task_id = ? AND tenant_id = ? AND requested_by = ? AND dispatch_state = 'dispatched' AND github_run_id = ? ON CONFLICT(id) DO NOTHING")
      .bind(`dispatch:${taskId}:reconciled`, new Date().toISOString(), taskId, tenantId, principal, runId),
  ]);
  if (result.some(item => item.success === false) || result[0]?.meta?.changes !== 1) throw new Error("Dispatch reconciliation unavailable");
}
