import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { computerApprovals, computerTaskEvents, requestRateLimits } from "../../../../../db/schema";
import { authenticatedAccount } from "../../../tasks/operator-auth.mjs";
import { enforceRateLimit, rateLimitSubjectForAccount } from "../../../rate-limit.mjs";
import { taskEvent } from "../../task-events";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const limited = await enforceRateLimit({
    db: getDb,
    table: requestRateLimits,
    request,
    subject: rateLimitSubjectForAccount(account),
    route: "computer_approval_decision",
    limit: 30,
    windowSeconds: 15 * 60,
  });
  if (limited) return limited;
  let body: { decision?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (body.decision !== "approved" && body.decision !== "rejected") return Response.json({ message: "Decision must be approved or rejected." }, { status: 400 });
  const { id } = await context.params;
  const now = new Date().toISOString();
  const db = getDb();
  const rows = await db.update(computerApprovals).set({ status: body.decision, decidedAt: now }).where(and(eq(computerApprovals.id, id), eq(computerApprovals.requestedBy, account.userId), eq(computerApprovals.status, "pending"), gt(computerApprovals.expiresAt, now)))
    .returning({ taskId: computerApprovals.taskId, summary: computerApprovals.summary });
  if (!rows.length) return Response.json({ message: "That approval was already decided, has expired, or is unavailable." }, { status: 409 });
  await db.insert(computerTaskEvents).values(taskEvent(rows[0].taskId, account.userId, body.decision, `Action ${body.decision}`, rows[0].summary));
  return Response.json({ decision: body.decision });
}
