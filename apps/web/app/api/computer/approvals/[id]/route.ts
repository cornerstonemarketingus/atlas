import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { computerApprovals } from "../../../../../db/schema";
import { authenticatedAccount } from "../../../tasks/operator-auth.mjs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { decision?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (body.decision !== "approved" && body.decision !== "rejected") return Response.json({ message: "Decision must be approved or rejected." }, { status: 400 });
  const { id } = await context.params;
  const now = new Date().toISOString();
  await getDb().update(computerApprovals).set({ status: body.decision, decidedAt: now }).where(and(eq(computerApprovals.id, id), eq(computerApprovals.requestedBy, account.userId), eq(computerApprovals.status, "pending")));
  return Response.json({ decision: body.decision });
}
