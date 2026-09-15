import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { accountDeletionRequests } from "../../../../db/schema";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const [row] = await getDb().select().from(accountDeletionRequests).where(eq(accountDeletionRequests.requestedBy, account.userId)).orderBy(desc(accountDeletionRequests.requestedAt)).limit(1);
  return Response.json({ request: row ?? null }, { headers: { "cache-control": "no-store" } });
}
export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  if (account.dbUserId === null) return Response.json({ message: "Operator access has no customer account to delete." }, { status: 400 });
  let body: { confirmation?: unknown }; try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (body.confirmation !== "DELETE") return Response.json({ message: "Type DELETE to confirm the request." }, { status: 400 });
  const db = getDb();
  const [pending] = await db.select().from(accountDeletionRequests).where(and(eq(accountDeletionRequests.requestedBy, account.userId), eq(accountDeletionRequests.status, "pending"))).limit(1);
  if (pending) return Response.json({ request: pending });
  const row = {
    id: randomUUID(),
    userId: account.dbUserId,
    requestedBy: account.userId,
    status: "pending",
    requestedAt: new Date().toISOString(),
  };
  await db.insert(accountDeletionRequests).values(row); return Response.json({ request: row }, { status: 201 });
}
