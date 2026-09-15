import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { computerApprovals, computerDevices, computerTasks } from "../../../../db/schema";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const db = getDb();
  const [tasks, approvals] = await Promise.all([
    db.select().from(computerTasks).where(eq(computerTasks.requestedBy, account.userId)).orderBy(desc(computerTasks.createdAt)).limit(20),
    db.select().from(computerApprovals).where(and(eq(computerApprovals.requestedBy, account.userId), eq(computerApprovals.status, "pending"), isNull(computerApprovals.decidedAt))).orderBy(desc(computerApprovals.createdAt)),
  ]);
  return Response.json({ tasks, approvals }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { deviceId?: unknown; objective?: unknown; startUrl?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  const objective = typeof body.objective === "string" ? body.objective.trim().slice(0, 2000) : "";
  let startUrl: string | null = null;
  if (typeof body.startUrl === "string" && body.startUrl.trim()) {
    try { const parsed = new URL(body.startUrl.trim()); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); startUrl = parsed.toString(); }
    catch { return Response.json({ message: "Start URL must be an http or https address." }, { status: 400 }); }
  }
  if (!deviceId || !objective) return Response.json({ message: "Choose a computer and describe the browser task." }, { status: 400 });
  const [device] = await getDb().select().from(computerDevices).where(and(eq(computerDevices.id, deviceId), eq(computerDevices.requestedBy, account.userId), isNull(computerDevices.revokedAt))).limit(1);
  if (!device) return Response.json({ message: "That computer is not paired." }, { status: 404 });
  const id = randomUUID();
  await getDb().insert(computerTasks).values({ id, requestedBy: account.userId, deviceId, objective, startUrl });
  return Response.json({ task: { id, status: "queued" } }, { status: 201 });
}
