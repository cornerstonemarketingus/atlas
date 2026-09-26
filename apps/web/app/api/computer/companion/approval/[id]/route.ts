import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { computerApprovals, computerTasks, requestRateLimits } from "../../../../../../db/schema";
import { authenticatedDevice } from "../../../companion-auth";
import { enforceRateLimit, rateLimitSubjectForDevice, rateLimitSubjectForIp, rateLimitedResponse } from "../../../../rate-limit.mjs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const device = await authenticatedDevice(request);
  const subject = device ? rateLimitSubjectForDevice(device) : rateLimitSubjectForIp(request);
  if (!subject) return rateLimitedResponse(15 * 60);
  const limited = await enforceRateLimit({
    db: getDb,
    table: requestRateLimits,
    request,
    subject,
    route: "computer_companion_approval",
    limit: 30,
    windowSeconds: 15 * 60,
  });
  if (limited) return limited;
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
  if (createHash("sha256").update(action).digest("hex") !== approval.actionHash) return Response.json({ status: "binding-mismatch" }, { status: 409 });
  const consumedAt = new Date().toISOString();
  // One approval, one action: the conditional update is the lock. Two devices
  // racing on the same approval both pass the reads above, but only one row
  // update can match, so only one of them is told it may act.
  const consumed = await db.update(computerApprovals).set({ status: "consumed", consumedAt })
    .where(and(eq(computerApprovals.id, id), eq(computerApprovals.status, "approved"), isNull(computerApprovals.consumedAt), gt(computerApprovals.expiresAt, consumedAt)))
    .returning({ id: computerApprovals.id });
  if (!consumed.length) return Response.json({ status: "already-consumed" }, { status: 409 });
  return Response.json({ status: "consumed", consumedAt });
}
