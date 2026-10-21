import { OBSERVATION_POLICY as P } from "./observation-policy.mjs";
import { githubRequestObservation } from "./github-observability.mjs";
const reasons = new Set(["rate_limit", "authentication", "permission", "not_found", "unavailable"]);
const MAX_DATE = 8640000000000000;
const stamp = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;

/** Header-only classification: provider bodies and raw header text never enter state. */
export function observerResponseFailure(response, failures = 0, now = Date.now()) {
  const { rateLimit: rate } = githubRequestObservation({ response, startedAt: now, endedAt: now });
  const reset = rate.remaining === 0 && Number.isSafeInteger(rate.resetEpochSeconds * 1000) ? rate.resetEpochSeconds * 1000 : 0;
  const rateLimited = response.status === 429 || (response.status === 403 && (rate.remaining === 0 || rate.retryAfterMs !== null)) || (response.ok && rate.remaining === 0 && reset > now);
  if (response.ok && !rateLimited) return null;
  const category = rateLimited ? "rate_limit" : response.status === 401 ? "authentication" : response.status === 403 ? "permission" : response.status === 404 ? "not_found" : "unavailable";
  const base = category === "rate_limit" ? Math.min(3600000, 60000 * 2 ** Math.min(6, Math.max(0, failures)))
    : ["authentication", "permission", "not_found"].includes(category) ? 3600000 : 900000;
  const requested = now + (rate.retryAfterMs ?? 0);
  const retryAt = Math.max(now + base, stamp(requested) ? requested : 0, stamp(reset) ? reset : 0);
  return { category, retryAt, shared: category !== "not_found" };
}

export function observerDeferred(failure) {
  return Object.assign(new Error("Automatic outcome observation deferred."), { observerStop: true, observerFailure: { category: failure.category, retryAt: failure.retryAt } });
}

export function safeObserverFailure(error, now) {
  const failure = error?.observerFailure;
  return failure && reasons.has(failure.category) && stamp(failure.retryAt) && failure.retryAt >= now
    ? { category: failure.category, retryAt: failure.retryAt }
    : { category: "unavailable", retryAt: now + 900000 };
}

export async function observerProviderState(d1) {
  return d1.prepare("SELECT category, retry_at AS retryAt, failures FROM task_observer_provider_state WHERE provider = 'github-actions'").first();
}

export async function recordProviderCooldown(d1, failure, now = Date.now()) {
  if (!failure.shared) return;
  if (!reasons.has(failure.category) || failure.category === "not_found" || !stamp(failure.retryAt)) throw new Error("Invalid observer pause");
  const result = await d1.prepare(`INSERT INTO task_observer_provider_state (provider, category, retry_at, failures, updated_at)
    VALUES ('github-actions', ?, ?, 1, ?)
    ON CONFLICT(provider) DO UPDATE SET
      category = CASE WHEN excluded.retry_at >= task_observer_provider_state.retry_at THEN excluded.category ELSE task_observer_provider_state.category END,
      retry_at = MAX(task_observer_provider_state.retry_at, excluded.retry_at), failures = MIN(8, task_observer_provider_state.failures + 1),
      updated_at = MAX(task_observer_provider_state.updated_at, excluded.updated_at)`)
    .bind(failure.category, failure.retryAt, now).run();
  if (result.success === false) throw new Error("Observer pause storage unavailable");
}

/** Health is selected only through the caller's exact scoped claim; aggregate budgets expose no other task details. */
export async function observationHealth(d1, scope, taskId, now = Date.now()) {
  const watch = await d1.prepare(`SELECT w.enabled, w.expires_at, w.next_check_at,
    (SELECT COUNT(*) FROM task_outcome_observations a WHERE a.task_id = w.task_id) AS attempts,
    EXISTS (SELECT 1 FROM task_execution_outcomes o WHERE o.task_id = w.task_id AND o.tenant_id = w.tenant_id AND o.requested_by = w.requested_by) AS observed
    FROM task_outcome_watches w JOIN task_execution_claims c ON c.task_id = w.task_id AND c.tenant_id = w.tenant_id AND c.requested_by = w.requested_by AND c.run_id = w.run_id AND c.run_attempt = w.run_attempt
    WHERE w.task_id = ? AND w.tenant_id = ? AND w.requested_by = ?`).bind(taskId, scope.tenantId, scope.principal).first();
  if (!watch) return null;
  const last = await d1.prepare(`SELECT status, reason, started_at, retry_at FROM task_outcome_observations
    WHERE task_id = ? AND tenant_id = ? AND requested_by = ? ORDER BY slot DESC LIMIT 1`).bind(taskId, scope.tenantId, scope.principal).first();
  const { provider, budget } = await observerHealthContext(d1, scope, now);
  return projectObserverHealth(watch, last, provider, budget, now);
}

export async function observerHealthContext(d1, scope, now = Date.now()) {
  const provider = await observerProviderState(d1);
  const budget = await d1.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN tenant_id = ? THEN 1 ELSE 0 END) AS tenant FROM task_outcome_observations WHERE day = ?")
    .bind(scope.tenantId, Math.floor(now / 86400000)).first();
  return { provider, budget, now };
}

export function projectObserverHealth(watch, last, provider, budget, now) {
  let state = "scheduled"; let reason = last?.reason ?? null;
  let next = Math.max(now, watch.next_check_at, last ? (Math.floor(last.started_at / P.intervalMs) + 1) * P.intervalMs : now);
  if (watch.observed) state = "observed";
  else if (!watch.enabled) state = "stopped";
  else if (watch.expires_at <= now) state = "expired";
  else if (watch.attempts >= P.perTask) state = "exhausted";
  else if (provider?.retryAt > now) { state = "provider_cooldown"; reason = provider.category; next = Math.max(next, provider.retryAt); }
  else if ((budget?.total ?? 0) >= P.globalDay || (budget?.tenant ?? 0) >= P.perTenantDay) { state = "budget_wait"; next = Math.max(next, (Math.floor(now / 86400000) + 1) * 86400000); }
  else if (watch.next_check_at > now) state = "check_backoff";
  else if (last?.status === "reserved" && next > now) state = "unconfirmed_reservation";
  return { state, reason, lastCheckAt: last ? new Date(last.started_at).toISOString() : null, lastStatus: last?.status ?? null,
    eligibleAfter: ["scheduled", "provider_cooldown", "budget_wait", "check_backoff", "unconfirmed_reservation"].includes(state) && next < watch.expires_at ? new Date(next).toISOString() : null };
}
