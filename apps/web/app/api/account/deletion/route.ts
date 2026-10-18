import { customerFailure } from '../../customer-failure.mjs';
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { accountDeletionRequests } from "../../../../db/schema";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";

async function handleGet(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const [row] = await getDb().select().from(accountDeletionRequests).where(eq(accountDeletionRequests.requestedBy, account.userId)).orderBy(desc(accountDeletionRequests.requestedAt)).limit(1);
  return Response.json({ request: publicRequest(row) }, { headers: { "cache-control": "no-store" } });
}
async function handlePost(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  if (account.dbUserId === null) return Response.json({ message: "Operator access has no customer account to delete." }, { status: 400 });
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || (body as { confirmation?: unknown }).confirmation !== "DELETE") return Response.json({ message: "Type DELETE to confirm the request." }, { status: 400 });
  const db = getDb();
  const [pending] = await db.select().from(accountDeletionRequests).where(and(eq(accountDeletionRequests.requestedBy, account.userId), eq(accountDeletionRequests.status, "pending"))).limit(1);
  if (pending) return Response.json({ request: publicRequest(pending) });
  const row = {
    id: randomUUID(),
    userId: account.dbUserId,
    requestedBy: account.userId,
    status: "pending",
    requestedAt: new Date().toISOString(),
  };
  await db.insert(accountDeletionRequests).values(row); return Response.json({ request: publicRequest(row) }, { status: 201 });
}

function publicRequest(row: { status: string; requestedAt: string } | undefined) {
  if (!row) return null;
  if (!["pending", "completed", "rejected"].includes(row.status) || !Number.isFinite(Date.parse(row.requestedAt))) throw new Error("Invalid deletion status");
  return { status: row.status, requestedAt: new Date(row.requestedAt).toISOString() };
}

export async function GET(request: Request) {
  try { return await handleGet(request); }
  catch { return customerFailure('deletion-status'); }
}
export async function POST(request: Request) {
  try { return await handlePost(request); }
  catch { return customerFailure('deletion-request'); }
}
