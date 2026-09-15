import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { computerDevices } from "../../../db/schema";

export function hashDeviceSecret(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export async function authenticatedDevice(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const credential = header.slice(7);
  const separator = credential.indexOf(".");
  if (separator < 1) return null;
  const id = credential.slice(0, separator);
  const secret = credential.slice(separator + 1);
  if (!secret) return null;
  const [device] = await getDb().select().from(computerDevices).where(eq(computerDevices.id, id)).limit(1);
  if (!device || device.revokedAt) return null;
  const actual = Buffer.from(hashDeviceSecret(secret));
  const expected = Buffer.from(device.secretHash);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return device;
}
