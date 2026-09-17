import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { computerDevices, computerTasks } from "../../../../../db/schema";
import { authenticatedDevice } from "../../companion-auth";
import { computerExecutionPolicy } from "../../computer-policy.mjs";

export async function POST(request: Request) {
  const device = await authenticatedDevice(request);
  if (!device) return Response.json({ message: "Device authentication failed." }, { status: 401 });
  try { await request.json(); } catch { /* an empty heartbeat is valid */ }
  const now = new Date().toISOString();
  const db = getDb();
  await db.update(computerDevices).set({ status: "online", lastSeenAt: now }).where(eq(computerDevices.id, device.id));
  const [task] = await db.select().from(computerTasks).where(and(eq(computerTasks.deviceId, device.id), eq(computerTasks.status, "queued"))).orderBy(asc(computerTasks.createdAt)).limit(1);
  if (task) await db.update(computerTasks).set({ status: "running", startedAt: now }).where(and(eq(computerTasks.id, task.id), eq(computerTasks.status, "queued")));
  return Response.json({ task: task ? { ...task, status: "running", policy: computerExecutionPolicy(task.workflowType) } : null });
}
