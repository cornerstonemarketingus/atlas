import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { computerTasks } from "../../../../../db/schema";
import { authenticatedAccount } from "../../../tasks/operator-auth.mjs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { action?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (body.action !== "cancel") return Response.json({ message: "Only cancellation is supported." }, { status: 400 });
  const { id } = await context.params;
  const rows = await getDb().update(computerTasks).set({ status: "cancelled", completedAt: new Date().toISOString() })
    .where(and(eq(computerTasks.id, id), eq(computerTasks.requestedBy, account.userId), inArray(computerTasks.status, ["queued", "running"])))
    .returning({ id: computerTasks.id });
  if (!rows.length) return Response.json({ message: "That task is already finished or unavailable." }, { status: 409 });
  return Response.json({ task: { id, status: "cancelled" } });
}
