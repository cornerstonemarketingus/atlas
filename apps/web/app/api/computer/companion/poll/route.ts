import { and, asc, eq, lt } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { computerDevices, computerTaskEvents, computerTasks } from "../../../../../db/schema";
import { authenticatedDevice } from "../../companion-auth";
import { computerExecutionPolicy } from "../../computer-policy.mjs";
import { leaseDeadline, taskEvent } from "../../task-events";

export async function POST(request: Request) {
  const device = await authenticatedDevice(request);
  if (!device) return Response.json({ message: "Device authentication failed." }, { status: 401 });
  try { await request.json(); } catch { /* an empty heartbeat is valid */ }
  const now = new Date().toISOString();
  const db = getDb();
  await db.update(computerDevices).set({ status: "online", lastSeenAt: now }).where(eq(computerDevices.id, device.id));
  const expiredLease = lt(computerTasks.leaseExpiresAt, now);
  const stale = await db.select().from(computerTasks).where(and(eq(computerTasks.deviceId, device.id), eq(computerTasks.status, "running"), expiredLease));
  for (const task of stale) {
    const recovered = await db.update(computerTasks).set({ status: "queued", leaseExpiresAt: null })
      .where(and(eq(computerTasks.id, task.id), eq(computerTasks.status, "running"), expiredLease)).returning({ id: computerTasks.id });
    if (recovered.length) await db.insert(computerTaskEvents).values(taskEvent(task.id, task.requestedBy, "recovered", "Recovered after companion disconnect", "The expired lease was returned to the queue."));
  }
  const [task] = await db.select().from(computerTasks).where(and(eq(computerTasks.deviceId, device.id), eq(computerTasks.status, "queued"))).orderBy(asc(computerTasks.createdAt)).limit(1);
  if (!task) return Response.json({ task: null });
  const [claimed] = await db.update(computerTasks).set({ status: "running", startedAt: task.startedAt ?? now, heartbeatAt: now, leaseExpiresAt: leaseDeadline(), attemptCount: task.attemptCount + 1 })
    .where(and(eq(computerTasks.id, task.id), eq(computerTasks.status, "queued"))).returning();
  if (!claimed) return Response.json({ task: null });
  await db.insert(computerTaskEvents).values(taskEvent(task.id, task.requestedBy, "started", task.attemptCount ? "Task resumed" : "Companion started task", `Attempt ${claimed.attemptCount}`));
  return Response.json({ task: { ...claimed, policy: computerExecutionPolicy(claimed.workflowType) } });
}
