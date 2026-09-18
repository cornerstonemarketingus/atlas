import { desc } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { accountDeletionRequests } from "../../../../../db/schema";
import { authenticatedAccount } from "../../../tasks/operator-auth.mjs";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (account?.userId !== "operator") return Response.json({ message: "Operator access is required." }, { status: 403 });
  const rows = await getDb().select().from(accountDeletionRequests).orderBy(desc(accountDeletionRequests.requestedAt)).limit(100);
  return Response.json({ requests: rows }, { headers: { "cache-control": "no-store" } });
}
