import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { taskUsage, users } from "../../../db/schema";
import { currentPlan } from "../billing/plan.mjs";
import { currentPeriodStart } from "../billing/period.mjs";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ signedIn: false });

  if (account.dbUserId === null) {
    return Response.json({ signedIn: true, userId: account.userId, unrestricted: true });
  }

  try {
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, account.dbUserId));
    const plan = await currentPlan(db, account.dbUserId);
    const periodStart = currentPeriodStart(new Date());
    const [usageRow] = await db.select().from(taskUsage).where(and(eq(taskUsage.userId, account.dbUserId), eq(taskUsage.periodStart, periodStart)));
    return Response.json({
      signedIn: true,
      userId: account.userId,
      githubLogin: user?.githubLogin ?? null,
      avatarUrl: user?.avatarUrl ?? null,
      tier: plan.tier,
      status: plan.status,
      usage: { used: usageRow?.taskCount ?? 0, limit: plan.limits.monthlyTasks },
      modes: plan.limits.modes,
    });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "Unexpected error." }, { status: 500 });
  }
}
