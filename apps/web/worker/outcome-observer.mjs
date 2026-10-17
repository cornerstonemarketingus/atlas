import { observeOutcomes } from "../app/api/tasks/outcome-observer.mjs";
import { verifySavedExecution } from "../app/api/tasks/claim-reconciliation.mjs";
import { createInstallationToken, githubAppConfiguration } from "../app/api/tasks/github-app.mjs";
import { platformGitHubToken } from "../app/api/tasks/github-token.mjs";

/** Cron owns only bounded observation, never coding execution. No active opt-in means no credential lookup. */
export async function scheduledOutcomeObservation(env, fetcher = fetch) {
  if (!env.DB) return { status: "disabled" };
  const deadline = Date.now() + 55000;
  const boundedFetch = (url, options = {}) => {
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("Observation deadline reached");
    return fetcher(url, { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(remaining)]) });
  };
  let token;
  try {
    return { status: "checked", ...await observeOutcomes(env.DB, async (task, claim) => {
      if (!token) {
        const app = githubAppConfiguration(env);
        token = app.configured ? await createInstallationToken(app, boundedFetch, { actions: "read" }) : platformGitHubToken(env);
        if (!token) throw new Error("Observation credential unavailable");
      }
      return verifySavedExecution(task, claim, token, boundedFetch);
    }) };
  } catch { console.warn("Atlas outcome observation unavailable; no execution authorized."); return { status: "unavailable" }; }
}
