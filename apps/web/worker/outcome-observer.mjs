import { observerResponseFailure, observerProviderState, observerDeferred, recordProviderCooldown } from "../app/api/tasks/observer-health.mjs";
import { observeOutcomes } from "../app/api/tasks/outcome-observer.mjs";
import { verifySavedExecution } from "../app/api/tasks/claim-reconciliation.mjs";
import { createInstallationToken, githubAppConfiguration } from "../app/api/tasks/github-app.mjs";
import { platformGitHubToken } from "../app/api/tasks/github-token.mjs";

/** Cron owns only bounded observation, never coding execution. No active opt-in means no credential lookup. */
export async function scheduledOutcomeObservation(env, fetcher = fetch) {
  if (!env.DB) return { status: "disabled" };
  const deadline = Date.now() + 55000;
  const boundedFetch = async (url, options = {}) => {
    const state = await observerProviderState(env.DB);
    if (state?.retryAt > Date.now()) throw observerDeferred({ category: state.category, retryAt: state.retryAt });
    const remaining = deadline - Date.now(); if (remaining <= 0) throw observerDeferred({ category: "unavailable", retryAt: Date.now() + 900000 });
    let response;
    try { response = await fetcher(url, { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(remaining)]) }); }
    catch { const failure = { category: "unavailable", retryAt: Date.now() + 900000, shared: true };
      await recordProviderCooldown(env.DB, failure).catch(() => {}); throw observerDeferred(failure);
    }
    const failure = observerResponseFailure(response, state?.failures ?? 0);
    if (failure) {
      try { await recordProviderCooldown(env.DB, failure); } catch { await response.body?.cancel(); throw observerDeferred(failure); }
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(observerDeferred(failure), { observerStop: failure.shared }); }
    }
    return response;
  };
  let token;
  try {
    return { status: "checked", ...await observeOutcomes(env.DB, async (task, claim) => {
      if (!token) {
        try {
          const app = githubAppConfiguration(env);
          token = app.configured ? await createInstallationToken(app, boundedFetch, { actions: "read" }) : platformGitHubToken(env);
          if (!token) throw new Error("Observation credential unavailable");
        } catch (error) {
          if (error?.observerFailure) throw error;
          const failure = { category: "authentication", retryAt: Date.now() + 3600000, shared: true };
          await recordProviderCooldown(env.DB, failure).catch(() => {}); throw observerDeferred(failure);
        }
      }
      const verified = await verifySavedExecution(task, claim, token, boundedFetch);
      await env.DB.prepare("UPDATE task_observer_provider_state SET failures = 0 WHERE provider = 'github-actions' AND retry_at <= ?").bind(Date.now()).run();
      return verified;
    }) };
  } catch { console.warn("Atlas outcome observation unavailable; no execution authorized."); return { status: "unavailable" }; }
}
