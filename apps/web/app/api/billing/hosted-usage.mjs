/**
 * Hosted browser minutes, metered separately from task counts.
 *
 * They are a different resource with a different cost: a task is a request,
 * a hosted browser minute is a container someone is paying to keep warm. A
 * single "monthly usage" number would let a customer burn a month of browser
 * time and still show most of their tasks unused, or the reverse.
 */
export const HOSTED_BROWSER_LIMITS = {
  free: { minutesPerMonth: 0, concurrent: 0, sessionMinutes: 0 },
  pro: { minutesPerMonth: 300, concurrent: 1, sessionMinutes: 15 },
  team: { minutesPerMonth: 2_000, concurrent: 5, sessionMinutes: 30 },
};

export function hostedBrowserAllowance(tier) {
  return HOSTED_BROWSER_LIMITS[tier] ?? HOSTED_BROWSER_LIMITS.free;
}

/**
 * Decides whether a hosted session may start. Pure, so the same rule can be
 * evaluated in the worker and in a test without a database.
 */
export function decideHostedSession({ tier, status, minutesUsed = 0, activeSessions = 0 }) {
  const limits = hostedBrowserAllowance(tier);
  if (status === "canceled") {
    return { allowed: false, code: "PLAN_REQUIRED", message: "Your subscription has ended. Hosted browser sessions need an active paid plan; your own companion still works.", limits };
  }
  if (limits.minutesPerMonth === 0) {
    return { allowed: false, code: "PLAN_REQUIRED", message: "Hosted browser sessions are part of a paid plan. Your own companion runs browser tasks at no extra cost.", limits };
  }
  if (activeSessions >= limits.concurrent) {
    return { allowed: false, code: "CONCURRENCY_REACHED", message: `Your plan allows ${limits.concurrent} hosted session${limits.concurrent === 1 ? "" : "s"} at a time.`, limits };
  }
  if (minutesUsed >= limits.minutesPerMonth) {
    return { allowed: false, code: "QUOTA_EXHAUSTED", message: `You have used all ${limits.minutesPerMonth} hosted browser minutes this period. Your own companion is unaffected.`, limits };
  }
  return { allowed: true, limits, remainingMinutes: limits.minutesPerMonth - minutesUsed };
}
