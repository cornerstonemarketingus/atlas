import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { computerTasks } from "../../../../../../db/schema";
import { authenticatedDevice } from "../../../companion-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const device = await authenticatedDevice(request);
  if (!device) return Response.json({ message: "Device authentication failed." }, { status: 401 });
  const { id } = await context.params;
  const [task] = await getDb().select({ id: computerTasks.id, status: computerTasks.status }).from(computerTasks)
    .where(and(eq(computerTasks.id, id), eq(computerTasks.deviceId, device.id))).limit(1);
  if (!task) return Response.json({ message: "Task not found." }, { status: 404 });
  return Response.json({ task }, { headers: { "cache-control": "no-store" } });
}
