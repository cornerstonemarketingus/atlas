import { and, count, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { computerTaskEvents, computerTasks } from "../../../../../db/schema";
import { authenticatedDevice } from "../../companion-auth";
import { taskEvent } from "../../task-events";

/** A running task may report at most this many steps, so a looping device cannot flood the timeline. */
const MAX_PROGRESS_EVENTS = 150;

/**
 * Step-by-step progress from the paired computer: which surface (browser or
 * desktop), what it did, and the evidence digest. This is what lets Operate
 * show what Atlas is doing right now instead of only "running".
 */
export async function POST(request: Request) {
  const device = await authenticatedDevice(request);
  if (!device) return Response.json({ message: "Device authentication failed." }, { status: 401 });
  let body: { taskId?: unknown; title?: unknown; detail?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 160) : "";
  const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, 1000) : null;
  if (!taskId || !title) return Response.json({ message: "A task id and a step title are required." }, { status: 400 });
  const db = getDb();
  const [task] = await db.select({ requestedBy: computerTasks.requestedBy }).from(computerTasks)
    .where(and(eq(computerTasks.id, taskId), eq(computerTasks.deviceId, device.id), eq(computerTasks.status, "running"))).limit(1);
  if (!task) return Response.json({ message: "Task is not running on this device." }, { status: 409 });
  const [{ value }] = await db.select({ value: count() }).from(computerTaskEvents).where(and(eq(computerTaskEvents.taskId, taskId), eq(computerTaskEvents.kind, "progress")));
  if (value >= MAX_PROGRESS_EVENTS) return Response.json({ recorded: false, message: "Progress limit reached for this task." }, { status: 429 });
  await db.insert(computerTaskEvents).values(taskEvent(taskId, task.requestedBy, "progress", title, detail));
  return Response.json({ recorded: true }, { status: 201 });
}
