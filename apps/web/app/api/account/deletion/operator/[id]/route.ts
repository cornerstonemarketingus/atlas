import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { accountDeletionRequests, computerApprovals, computerDevices, computerTaskEvents, computerTasks, conversationMessages, conversations, runEvents, subscriptions, tasks, taskUsage, users } from "../../../../../../db/schema";
import { authenticatedAccount } from "../../../../tasks/operator-auth.mjs";
import { validateDeletionDecision } from "../validation.mjs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (account?.userId !== "operator") return Response.json({ message: "Operator access is required." }, { status: 403 });
  const { id } = await context.params;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const validated = validateDeletionDecision(body, id);
  if ("error" in validated) return Response.json({ message: validated.error }, { status: validated.status });

  const db = getDb();
  const [deletion] = await db.select().from(accountDeletionRequests).where(and(eq(accountDeletionRequests.id, id), eq(accountDeletionRequests.status, "pending"))).limit(1);
  if (!deletion) return Response.json({ message: "Pending deletion request not found." }, { status: 404 });
  const completedAt = new Date().toISOString();
  const status = validated.decision.action === "complete" ? "completed" : "rejected";

  if (status === "rejected") {
    await db.update(accountDeletionRequests).set({ status, completedAt, processedBy: account.userId, processingNote: validated.decision.note }).where(eq(accountDeletionRequests.id, id));
    return Response.json({ id, status, completedAt });
  }

  if (deletion.userId === null) return Response.json({ message: "This request is missing its account reference and cannot be processed automatically." }, { status: 409 });
  const principal = deletion.requestedBy;
  await db.batch([
    db.delete(computerApprovals).where(eq(computerApprovals.requestedBy, principal)),
    db.delete(computerTaskEvents).where(eq(computerTaskEvents.requestedBy, principal)),
    db.delete(computerTasks).where(eq(computerTasks.requestedBy, principal)),
    db.delete(computerDevices).where(eq(computerDevices.requestedBy, principal)),
    db.delete(runEvents).where(eq(runEvents.requestedBy, principal)),
    db.delete(conversationMessages).where(eq(conversationMessages.requestedBy, principal)),
    db.delete(conversations).where(eq(conversations.requestedBy, principal)),
    db.delete(tasks).where(eq(tasks.requestedBy, principal)),
    db.delete(taskUsage).where(eq(taskUsage.userId, deletion.userId)),
    db.delete(subscriptions).where(eq(subscriptions.userId, deletion.userId)),
    db.update(accountDeletionRequests).set({ userId: null, status, completedAt, processedBy: account.userId, processingNote: validated.decision.note || "Eligible Atlas account data deleted." }).where(eq(accountDeletionRequests.id, id)),
    db.delete(users).where(eq(users.id, deletion.userId)),
  ]);
  return Response.json({ id, status, completedAt });
}
