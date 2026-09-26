import { eq, lt } from "drizzle-orm";
import { getDb } from "../../../db";
import { revokedSessions, sessionRevocations } from "../../../db/schema";

/** D1-backed store for checkRevocation / revokeSession. */
export function d1RevocationStore() {
  const db = getDb();
  return {
    async isSidRevoked(sid: string) {
      const rows = await db.select({ sid: revokedSessions.sid }).from(revokedSessions).where(eq(revokedSessions.sid, sid)).limit(1);
      return rows.length > 0;
    },
    async revokedBefore(principal: string) {
      const rows = await db.select({ before: sessionRevocations.revokedBefore }).from(sessionRevocations).where(eq(sessionRevocations.principal, principal)).limit(1);
      return rows[0]?.before ?? null;
    },
    async revokeSid({ sid, principal, expiresAt, now }: { sid: string; principal: string; expiresAt: string; now: number }) {
      const at = new Date(now).toISOString();
      await db.insert(revokedSessions).values({ sid, principal, revokedAt: at, expiresAt }).onConflictDoNothing();
      // Expired entries can never match a live token again; keep the table small.
      await db.delete(revokedSessions).where(lt(revokedSessions.expiresAt, at));
    },
    async revokeAll({ principal, before, now }: { principal: string; before: number; now: number }) {
      const at = new Date(now).toISOString();
      await db.insert(sessionRevocations).values({ principal, revokedBefore: before, updatedAt: at })
        .onConflictDoUpdate({ target: sessionRevocations.principal, set: { revokedBefore: before, updatedAt: at } });
    },
  };
}
