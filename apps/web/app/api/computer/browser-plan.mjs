export const CLOUD_BROWSER_MINUTES = Object.freeze({ free: 0, pro: 60, team: 300 });

export function cloudBrowserAccess(tier, configured, unrestricted = false) {
  const monthlyMinutes = unrestricted ? null : CLOUD_BROWSER_MINUTES[tier] ?? 0;
  const entitled = unrestricted || monthlyMinutes > 0;
  return { available: entitled && configured, entitled, configured, monthlyMinutes };
}

/**
 * Whether hosted browsing can actually run a task.
 *
 * Setting ATLAS_CLOUDFLARE_BROWSER_ENABLED used to be enough to accept hosted
 * tasks, but nothing consumes them: the Worker has no Browser Rendering
 * binding and no executor leases `executionProvider = cloudflare` rows, so
 * they queued forever (SECURITY-REVIEW SEC-10). Until an executor exists this
 * stays false, and the option is shown as unavailable instead of accepting
 * work that will never start.
 */
export const HOSTED_BROWSER_EXECUTOR_AVAILABLE = false;

export function hostedBrowserConfigured(environment = process.env, executorAvailable = HOSTED_BROWSER_EXECUTOR_AVAILABLE) {
  return executorAvailable && environment.ATLAS_CLOUDFLARE_BROWSER_ENABLED === "true";
}
