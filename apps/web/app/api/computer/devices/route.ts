import { randomBytes, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { computerDevices } from "../../../../db/schema";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { hashDeviceSecret } from "../companion-auth";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const rows = await getDb().select().from(computerDevices).where(eq(computerDevices.requestedBy, account.userId)).orderBy(desc(computerDevices.createdAt));
  return Response.json({ devices: rows.map(({ secretHash: _secretHash, ...device }) => device) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { name?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return Response.json({ message: "Give this computer a name." }, { status: 400 });
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await getDb().insert(computerDevices).values({ id, requestedBy: account.userId, name, secretHash: hashDeviceSecret(secret) });
  return Response.json({ device: { id, name, platform: "windows", status: "offline" }, credential: `${id}.${secret}` }, { status: 201 });
}
