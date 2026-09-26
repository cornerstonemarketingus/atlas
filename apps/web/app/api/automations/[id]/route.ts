import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { automations } from "../../../../db/schema";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { paused?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (typeof body.paused !== "boolean") return Response.json({ message: "Paused flag is required." }, { status: 400 });
  const { id } = await context.params;
  const now = new Date().toISOString();
  const rows = await getDb().update(automations)
    .set({ pausedAt: body.paused ? now : null, updatedAt: now })
    .where(and(eq(automations.id, id), eq(automations.requestedBy, account.userId)))
    .returning({ id: automations.id, pausedAt: automations.pausedAt });
  if (rows.length === 0) return Response.json({ message: "Automation not found." }, { status: 404 });
  return Response.json({ automation: { id: rows[0].id, paused: rows[0].pausedAt !== null, pausedAt: rows[0].pausedAt } });
}
