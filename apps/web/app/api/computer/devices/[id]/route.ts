import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { computerDevices } from "../../../../../db/schema";
import { authenticatedAccount } from "../../../tasks/operator-auth.mjs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const { id } = await context.params;
  await getDb().update(computerDevices).set({ revokedAt: new Date().toISOString(), status: "revoked" }).where(and(eq(computerDevices.id, id), eq(computerDevices.requestedBy, account.userId)));
  return Response.json({ revoked: true });
}
