export const CLOUD_BROWSER_MINUTES = Object.freeze({ free: 0, pro: 60, team: 300 });

export function cloudBrowserAccess(tier, configured, unrestricted = false) {
  const monthlyMinutes = unrestricted ? null : CLOUD_BROWSER_MINUTES[tier] ?? 0;
  const entitled = unrestricted || monthlyMinutes > 0;
  return { available: entitled && configured, entitled, configured, monthlyMinutes };
}
