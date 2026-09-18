import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { computerApprovals, computerTaskEvents, computerTasks } from "../../../../../db/schema";
import { authenticatedDevice } from "../../companion-auth";
import { taskEvent } from "../../task-events";

export async function POST(request: Request) {
  const device = await authenticatedDevice(request);
  if (!device) return Response.json({ message: "Device authentication failed." }, { status: 401 });
  let body: { taskId?: unknown; summary?: unknown; domain?: unknown; action?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 500) : "";
  const action = typeof body.action === "string" ? body.action : JSON.stringify(body.action ?? null);
  const [task] = await getDb().select().from(computerTasks).where(and(eq(computerTasks.id, taskId), eq(computerTasks.deviceId, device.id), eq(computerTasks.status, "running"))).limit(1);
  if (!task || !summary || action.length > 8000) return Response.json({ message: "Approval request is invalid." }, { status: 400 });
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await getDb().insert(computerApprovals).values({
    id, taskId, requestedBy: task.requestedBy, summary,
    domain: typeof body.domain === "string" ? body.domain.slice(0, 255) : null,
    actionHash: createHash("sha256").update(action).digest("hex"), expiresAt,
  });
  await getDb().insert(computerTaskEvents).values(taskEvent(taskId, task.requestedBy, "approval-requested", "Approval requested", summary));
  return Response.json({ approval: { id, status: "pending", expiresAt } }, { status: 201 });
}
