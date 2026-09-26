import { getDb } from "../../../../../db";
import { computerApprovals, computerTaskEvents } from "../../../../../db/schema";
import { authenticatedAccount } from "../../../tasks/operator-auth.mjs";
import { taskEvent } from "../../task-events";
import { decideApproval } from "../../approval-state.mjs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { decision?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (body.decision !== "approved" && body.decision !== "rejected") return Response.json({ message: "Decision must be approved or rejected." }, { status: 400 });
  const { id } = await context.params;
  const now = new Date().toISOString();
  const db = getDb();
  const rows = await decideApproval(db, computerApprovals, { id, owner: account.userId, decision: body.decision, now });
  if (!rows.length) return Response.json({ message: "That approval was already decided, has expired, or is unavailable." }, { status: 409 });
  await db.insert(computerTaskEvents).values(taskEvent(rows[0].taskId, account.userId, body.decision, `Action ${body.decision}`, rows[0].summary));
  return Response.json({ decision: body.decision });
}
