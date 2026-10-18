import { eq, lt, sql } from "drizzle-orm";
import { subscriptions, taskUsage, TIER_LIMITS } from "../../../db/schema";
import { currentChatDayKey, currentPeriodStart, nextChatReset } from "./period.mjs";

export async function currentPlan(db, dbUserId) {
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.userId, dbUserId));
  const tier = subscription && subscription.status === "active" ? subscription.tier : "free";
  return { tier, status: subscription?.status ?? "active", limits: TIER_LIMITS[tier] };
}

/**
 * Checks whether `mode` is allowed on the user's plan and their monthly task
 * count is under its cap, incrementing the count if so. The check and the
 * increment are one atomic upsert (the increment applies only while the count
 * is below the cap), so concurrent requests can neither overwrite each other's
 * increments nor push the count past the cap.
 */
export async function checkAndRecordUsage(db, dbUserId, mode, now = new Date()) {
  const plan = await currentPlan(db, dbUserId);
  if (!plan.limits.modes.includes(mode)) {
    return { allowed: false, reason: `The '${mode}' mode requires upgrading past the ${plan.tier} plan.`, tier: plan.tier };
  }

  const limit = plan.limits.monthlyTasks;
  const denied = {
    allowed: false,
    reason: `Monthly task limit reached (${limit} for the ${plan.tier} plan). It resets next month, or upgrade for a higher limit.`,
    tier: plan.tier,
  };
  if (limit < 1) return denied;

  const periodStart = currentPeriodStart(now);
  const [row] = await db
    .insert(taskUsage)
    .values({ userId: dbUserId, periodStart, taskCount: 1 })
    .onConflictDoUpdate({
      target: [taskUsage.userId, taskUsage.periodStart],
      set: { taskCount: sql`${taskUsage.taskCount} + 1` },
      setWhere: lt(taskUsage.taskCount, limit),
    })
    .returning({ taskCount: taskUsage.taskCount });
  if (!row) return denied;
  return { allowed: true, tier: plan.tier, used: row.taskCount, limit };
}

/**
 * Counts one hosted chat message against the user's daily cap. Same shape as
 * checkAndRecordUsage: one upsert that increments only while the count is
 * below the plan's cap, so concurrent messages cannot overshoot it. A denial
 * says when the cap resets and what upgrading changes; it never silently
 * downgrades the reply.
 */
export async function checkAndRecordChatUsage(db, dbUserId, now = new Date()) {
  const plan = await currentPlan(db, dbUserId);
  const limit = plan.limits.dailyChatMessages;
  const resetsAt = nextChatReset(now);
  const denied = {
    allowed: false,
    code: "CHAT_CAP_REACHED",
    tier: plan.tier,
    limit,
    resetsAt,
    reason: plan.tier === "free"
      ? `You have used today's ${limit} free messages. They reset at 00:00 UTC, or upgrade at /pricing for a higher daily limit.`
      : `You have used today's ${limit} messages on the ${plan.tier} plan. They reset at 00:00 UTC.`,
  };
  if (limit < 1) return denied;

  const [row] = await db
    .insert(taskUsage)
    .values({ userId: dbUserId, periodStart: currentChatDayKey(now), taskCount: 1 })
    .onConflictDoUpdate({
      target: [taskUsage.userId, taskUsage.periodStart],
      set: { taskCount: sql`${taskUsage.taskCount} + 1` },
      setWhere: lt(taskUsage.taskCount, limit),
    })
    .returning({ taskCount: taskUsage.taskCount });
  if (!row) return denied;
  return { allowed: true, code: null, reason: null, tier: plan.tier, used: row.taskCount, limit, remaining: limit - row.taskCount, resetsAt };
}
