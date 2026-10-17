import { inspectTaskRequest } from "./request-inspection.mjs";
import { reconcileSavedRequest } from "./claim-reconciliation.mjs";

export const OBSERVATION_POLICY = Object.freeze({ intervalMs: 900000, lifetimeMs: 86400000, perTask: 8, perTenantDay: 8, globalDay: 48, perTick: 2, activeTenant: 32, activeGlobal: 256 });
const membership = `(w.requested_by = 'operator' AND w.tenant_id = 1 AND w.user_id IS NULL
  OR w.user_id IS NOT NULL AND w.user_id = t.user_id AND EXISTS
    (SELECT 1 FROM tenant_members m WHERE m.tenant_id = w.tenant_id AND m.user_id = w.user_id))`;
const joins = `FROM task_outcome_watches w
  JOIN tasks t ON t.task_id = w.task_id AND t.tenant_id = w.tenant_id AND t.requested_by = w.requested_by
  JOIN task_execution_claims c ON c.task_id = w.task_id AND c.tenant_id = w.tenant_id AND c.requested_by = w.requested_by AND c.run_id = w.run_id AND c.run_attempt = w.run_attempt
  JOIN task_requests r ON r.request_key = w.request_key AND r.tenant_id = w.tenant_id AND r.requested_by = w.requested_by AND r.correlation_id = t.correlation_id
  JOIN conversations v ON v.id = t.conversation_id AND v.tenant_id = w.tenant_id AND v.requested_by = w.requested_by`;
const eligible = `w.enabled = 1 AND w.expires_at > ? AND w.created_at <= ? AND ${membership}
  AND t.execution_provider = 'managed' AND t.repository = 'cornerstonemarketingus/atlas'
  AND t.dispatch_state IN ('dispatching', 'dispatched', 'unknown')
  AND NOT EXISTS (SELECT 1 FROM task_execution_outcomes o WHERE o.task_id = w.task_id)
  AND NOT EXISTS (SELECT 1 FROM task_outcome_observations a WHERE a.task_id = w.task_id AND a.slot = ?)
  AND (SELECT COUNT(*) FROM tasks x WHERE x.tenant_id = w.tenant_id AND x.requested_by = w.requested_by AND x.correlation_id = r.correlation_id) = 1
  AND (SELECT COUNT(*) FROM task_outcome_observations a WHERE a.day = ?) < ${OBSERVATION_POLICY.globalDay}
  AND (SELECT COUNT(*) FROM task_outcome_observations a WHERE a.day = ? AND a.tenant_id = w.tenant_id) < ${OBSERVATION_POLICY.perTenantDay}
  AND (SELECT COUNT(*) FROM task_outcome_observations a WHERE a.task_id = w.task_id) < ${OBSERVATION_POLICY.perTask}`;
const timing = now => [now, now, Math.floor(now / OBSERVATION_POLICY.intervalMs), Math.floor(now / 86400000), Math.floor(now / 86400000)];

async function persistConsent(d1, statement, scope, saved, enabled, now) {
  const results = await d1.batch([statement,
    d1.prepare(`INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at)
      SELECT ?, t.conversation_id, w.task_id, w.requested_by, 'observation-setting', ?, ?, ?
      FROM task_outcome_watches w JOIN tasks t ON t.task_id = w.task_id AND t.tenant_id = w.tenant_id AND t.requested_by = w.requested_by
      JOIN conversations v ON v.id = t.conversation_id AND v.tenant_id = w.tenant_id AND v.requested_by = w.requested_by
      WHERE w.task_id = ? AND w.tenant_id = ? AND w.requested_by = ? AND w.enabled = ? AND w.updated_at = ? ON CONFLICT(id) DO NOTHING`)
      .bind(`watch:${saved.task.taskId}:${now}:${enabled ? 1 : 0}`, enabled ? "Automatic outcome checks enabled" : "Automatic outcome checks stopped",
        "Consent changes observation only. No execution or retry is authorized.", new Date(now).toISOString(), saved.task.taskId,
        scope.tenantId, scope.principal, enabled ? 1 : 0, now),
  ]);
  if (results.some(value => value.success === false)) throw new Error("Observation configuration unavailable");
  return results[0];
}

/** Consent is scoped to a saved request, durable member and exact claim. Toggling never extends its lifetime. */
export async function configureObservation(d1, scope, key, userId, enabled, now = Date.now()) {
  const saved = await inspectTaskRequest(d1, scope, key);
  if (!saved) return { status: "not-found" };
  if (!saved.task?.execution || (enabled && saved.task.execution.outcome)) return { status: "not-eligible" };
  if (!enabled) {
    const disabled = await persistConsent(d1, d1.prepare("UPDATE task_outcome_watches SET enabled = 0, updated_at = ? WHERE task_id = ? AND tenant_id = ? AND requested_by = ? AND run_id = ? AND run_attempt = ?")
      .bind(now, saved.task.taskId, scope.tenantId, scope.principal, saved.task.execution.runId, saved.task.execution.runAttempt), scope, saved, false, now);
    if (disabled.success === false) throw new Error("Observation configuration unavailable");
    return { status: "configured", request: await inspectTaskRequest(d1, scope, key) };
  }
  const result = await persistConsent(d1, d1.prepare(`INSERT INTO task_outcome_watches
    (task_id, tenant_id, requested_by, user_id, request_key, run_id, run_attempt, enabled, created_at, expires_at, updated_at)
    SELECT t.task_id, t.tenant_id, t.requested_by, ?, ?, c.run_id, c.run_attempt, ?, ?, ?, ?
    FROM tasks t JOIN task_execution_claims c ON c.task_id = t.task_id AND c.tenant_id = t.tenant_id AND c.requested_by = t.requested_by
    JOIN conversations v ON v.id = t.conversation_id AND v.tenant_id = t.tenant_id AND v.requested_by = t.requested_by
    WHERE t.task_id = ? AND t.tenant_id = ? AND t.requested_by = ? AND t.execution_provider = 'managed'
    AND t.repository = 'cornerstonemarketingus/atlas'
    AND ((t.requested_by = 'operator' AND t.tenant_id = 1 AND ? IS NULL) OR
      (? IS NOT NULL AND t.user_id = ? AND EXISTS (SELECT 1 FROM tenant_members m WHERE m.tenant_id = t.tenant_id AND m.user_id = ?)))
    AND (SELECT COUNT(*) FROM task_outcome_watches w WHERE w.enabled = 1 AND w.expires_at > ? AND w.task_id != t.task_id) < ${OBSERVATION_POLICY.activeGlobal}
    AND (SELECT COUNT(*) FROM task_outcome_watches w WHERE w.enabled = 1 AND w.expires_at > ? AND w.tenant_id = t.tenant_id AND w.task_id != t.task_id) < ${OBSERVATION_POLICY.activeTenant}
    ON CONFLICT(task_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    WHERE task_outcome_watches.tenant_id = excluded.tenant_id AND task_outcome_watches.requested_by = excluded.requested_by
      AND task_outcome_watches.run_id = excluded.run_id AND task_outcome_watches.run_attempt = excluded.run_attempt
      AND (excluded.enabled = 0 OR task_outcome_watches.expires_at > ?)`)
    .bind(userId, key, enabled ? 1 : 0, now, now + OBSERVATION_POLICY.lifetimeMs, now, saved.task.taskId, scope.tenantId, scope.principal,
      userId, userId, userId, userId, now, now, now), scope, saved, true, now);
  if (result.success === false) throw new Error("Observation configuration unavailable");
  return result.meta?.changes === 1 ? { status: "configured", request: await inspectTaskRequest(d1, scope, key) } : { status: "not-eligible" };
}

export async function observationCandidates(d1, now = Date.now()) {
  const { results } = await d1.prepare(`SELECT w.task_id AS taskId, w.tenant_id AS tenantId, w.requested_by AS principal, w.request_key AS requestKey
    ${joins} WHERE ${eligible}
    ORDER BY COALESCE((SELECT MAX(a.started_at) FROM task_outcome_observations a WHERE a.task_id = w.task_id), 0), w.created_at, w.task_id LIMIT ${OBSERVATION_POLICY.perTick}`)
    .bind(...timing(now)).all();
  return results;
}

/** Atomic budget reservation and audit precede credentials or GitHub reads. Uncertain reservations are never refunded. */
export async function reserveObservation(d1, candidate, now = Date.now()) {
  const slot = Math.floor(now / OBSERVATION_POLICY.intervalMs); const day = Math.floor(now / 86400000);
  const result = await d1.batch([
    d1.prepare(`INSERT INTO task_outcome_observations
      (task_id, tenant_id, requested_by, run_id, run_attempt, slot, day, status, started_at)
      SELECT w.task_id, w.tenant_id, w.requested_by, w.run_id, w.run_attempt, ?, ?, 'reserved', ? ${joins}
      WHERE w.task_id = ? AND w.tenant_id = ? AND w.requested_by = ? AND ${eligible}
      ON CONFLICT(task_id, slot) DO NOTHING`).bind(slot, day, now, candidate.taskId, candidate.tenantId, candidate.principal, ...timing(now)),
    d1.prepare(`INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at)
      SELECT ?, t.conversation_id, a.task_id, a.requested_by, 'observation', 'Outcome observation reserved', 'A bounded metadata check was reserved. No execution is authorized.', ?
      FROM task_outcome_observations a JOIN tasks t ON t.task_id = a.task_id AND t.tenant_id = a.tenant_id AND t.requested_by = a.requested_by
      WHERE a.task_id = ? AND a.tenant_id = ? AND a.requested_by = ? AND a.slot = ? ON CONFLICT(id) DO NOTHING`)
      .bind(`observe:${candidate.taskId}:${slot}`, new Date(now).toISOString(), candidate.taskId, candidate.tenantId, candidate.principal, slot),
  ]);
  if (result.some(value => value.success === false)) throw new Error("Observation reservation unavailable");
  return result[0]?.meta?.changes === 1 ? slot : null;
}

/** A bounded sequential tick. Duplicate deliveries cannot replay a reserved slot. */
export async function observeOutcomes(d1, verify, clock = Date.now) {
  const started = clock(); const candidates = await observationCandidates(d1, started);
  const summary = { reserved: 0, observed: 0, unavailable: 0 };
  for (const candidate of candidates) {
    if (clock() - started >= 55000) break;
    const slot = await reserveObservation(d1, candidate, clock()); if (slot === null) continue;
    summary.reserved++;
    let status = "unconfirmed";
    try {
      const result = await reconcileSavedRequest(d1, { tenantId: candidate.tenantId, principal: candidate.principal }, candidate.requestKey, verify);
      if (result.status === "observed") { status = "observed"; summary.observed++; }
    } catch { status = "unavailable"; summary.unavailable++; }
    await d1.prepare(`UPDATE task_outcome_observations SET status = ?, finished_at = ?
      WHERE task_id = ? AND tenant_id = ? AND requested_by = ? AND slot = ? AND status = 'reserved'`)
      .bind(status, clock(), candidate.taskId, candidate.tenantId, candidate.principal, slot).run();
  }
  return summary;
}
