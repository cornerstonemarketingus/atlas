import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { computerTaskEvents, computerTasks } from "../../../../../db/schema";
import { authenticatedDevice } from "../../companion-auth";
import { taskEvent } from "../../task-events";

export async function POST(request: Request) {
  const device = await authenticatedDevice(request);
  if (!device) return Response.json({ message: "Device authentication failed." }, { status: 401 });
  let body: { taskId?: unknown; status?: unknown; result?: unknown; error?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const status = body.status === "completed" ? "completed" : body.status === "failed" ? "failed" : "";
  if (!taskId || !status) return Response.json({ message: "A task id and terminal status are required." }, { status: 400 });
  const db = getDb();
  const changed = await db.update(computerTasks).set({
    status,
    result: typeof body.result === "string" ? body.result.slice(0, 4000) : null,
    error: typeof body.error === "string" ? body.error.slice(0, 2000) : null,
    completedAt: new Date().toISOString(),
    leaseExpiresAt: null,
  }).where(and(eq(computerTasks.id, taskId), eq(computerTasks.deviceId, device.id), eq(computerTasks.status, "running")))
    .returning({ requestedBy: computerTasks.requestedBy });
  if (!changed.length) return Response.json({ message: "Task is no longer running; the report was not applied." }, { status: 409 });
  const detail = status === "completed" ? (typeof body.result === "string" ? body.result : null) : (typeof body.error === "string" ? body.error : null);
  await db.insert(computerTaskEvents).values(taskEvent(taskId, changed[0].requestedBy, status, status === "completed" ? "Task completed" : "Task failed", detail));
  return Response.json({ recorded: true });
}
