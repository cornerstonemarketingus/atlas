import { and, eq } from "drizzle-orm";
import { subscriptions, taskUsage, TIER_LIMITS } from "../../../db/schema";
import { currentPeriodStart } from "./period.mjs";

export async function currentPlan(db, dbUserId) {
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.userId, dbUserId));
  const tier = subscription && subscription.status === "active" ? subscription.tier : "free";
  return { tier, status: subscription?.status ?? "active", limits: TIER_LIMITS[tier] };
}

/**
 * Checks whether `mode` is allowed on the user's plan and their monthly task
 * count is under its cap, incrementing the count if so. The read-then-write
 * isn't transactional, so a burst of concurrent requests right at the cap
 * could let a few extra tasks through — an acceptable soft limit for a
 * subscription cap, not a security boundary.
 */
export async function checkAndRecordUsage(db, dbUserId, mode, now = new Date()) {
  const plan = await currentPlan(db, dbUserId);
  if (!plan.limits.modes.includes(mode)) {
    return { allowed: false, reason: `The '${mode}' mode requires upgrading past the ${plan.tier} plan.`, tier: plan.tier };
  }

  const periodStart = currentPeriodStart(now);
  const [existing] = await db.select().from(taskUsage).where(and(eq(taskUsage.userId, dbUserId), eq(taskUsage.periodStart, periodStart)));
  const used = existing ? existing.taskCount : 0;
  if (used >= plan.limits.monthlyTasks) {
    return {
      allowed: false,
      reason: `Monthly task limit reached (${plan.limits.monthlyTasks} for the ${plan.tier} plan). It resets next month, or upgrade for a higher limit.`,
      tier: plan.tier,
    };
  }

  await db
    .insert(taskUsage)
    .values({ userId: dbUserId, periodStart, taskCount: 1 })
    .onConflictDoUpdate({ target: [taskUsage.userId, taskUsage.periodStart], set: { taskCount: used + 1 } });
  return { allowed: true, tier: plan.tier, used: used + 1, limit: plan.limits.monthlyTasks };
}
