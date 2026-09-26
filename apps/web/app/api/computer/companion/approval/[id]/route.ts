import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { computerApprovals, computerTasks } from "../../../../../../db/schema";
import { authenticatedDevice } from "../../../companion-auth";
import { consumeApproval } from "../../../approval-state.mjs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const device = await authenticatedDevice(request);
  if (!device) return Response.json({ message: "Device authentication failed." }, { status: 401 });
  let body: { action?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const action = typeof body.action === "string" ? body.action : JSON.stringify(body.action ?? null);
  const { id } = await context.params;
  const db = getDb();
  const [approval] = await db.select().from(computerApprovals).where(eq(computerApprovals.id, id)).limit(1);
  if (!approval) return Response.json({ message: "Approval not found." }, { status: 404 });
  const [task] = await db.select().from(computerTasks).where(and(eq(computerTasks.id, approval.taskId), eq(computerTasks.deviceId, device.id))).limit(1);
  if (!task) return Response.json({ message: "Approval not found." }, { status: 404 });
  if (approval.status !== "approved") return Response.json({ status: approval.status }, { status: 409 });
  if (approval.consumedAt || approval.expiresAt <= new Date().toISOString()) return Response.json({ status: "expired" }, { status: 409 });
  const actionHash = createHash("sha256").update(action).digest("hex");
  if (actionHash !== approval.actionHash) return Response.json({ status: "binding-mismatch" }, { status: 409 });
  // The checks above only choose the error message. Authorization is the
  // conditional UPDATE: only the one request whose UPDATE matched the row
  // may act, so a concurrent second consumer gets 409, never "consumed".
  const consumed = await consumeApproval(db, computerApprovals, { id, actionHash });
  if (!consumed) return Response.json({ status: "already-consumed" }, { status: 409 });
  return Response.json({ status: "consumed", consumedAt: consumed.consumedAt });
}
