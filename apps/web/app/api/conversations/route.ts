import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { conversations } from "../../../db/schema";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  try {
    const rows = await getDb().select().from(conversations).where(eq(conversations.requestedBy, account.userId)).orderBy(desc(conversations.updatedAt)).limit(50);
    return Response.json({ conversations: rows }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ conversations: [], historyAvailable: false });
  }
}
