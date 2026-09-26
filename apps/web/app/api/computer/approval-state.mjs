import { and, eq, gt, isNull } from "drizzle-orm";

/**
 * Approval state transitions as single conditional UPDATEs.
 *
 * Every precondition lives in the WHERE clause and the caller acts only on the
 * rows RETURNING hands back. A read-then-write ("is it approved? then mark it
 * consumed") lets two concurrent consumers both pass the read, so one approval
 * could authorize two actions; here the database decides, and exactly one
 * UPDATE can match the row.
 */

/**
 * Consumes an approved, unexpired, unconsumed approval whose action hash
 * matches. Returns `{ id, consumedAt }` for the one caller that won, or null.
 */
export async function consumeApproval(db, approvals, { id, actionHash, now = new Date().toISOString() }) {
  const rows = await db.update(approvals)
    .set({ status: "consumed", consumedAt: now })
    .where(and(
      eq(approvals.id, id),
      eq(approvals.status, "approved"),
      isNull(approvals.consumedAt),
      gt(approvals.expiresAt, now),
      eq(approvals.actionHash, actionHash),
    ))
    .returning({ id: approvals.id, consumedAt: approvals.consumedAt });
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Records the owner's decision on a pending approval that has not expired.
 * An approval granted after its window would otherwise sit "approved" but
 * unusable, and the owner would believe they had authorized something.
 */
export async function decideApproval(db, approvals, { id, owner, decision, now = new Date().toISOString() }) {
  return db.update(approvals)
    .set({ status: decision, decidedAt: now })
    .where(and(
      eq(approvals.id, id),
      eq(approvals.requestedBy, owner),
      eq(approvals.status, "pending"),
      gt(approvals.expiresAt, now),
    ))
    .returning({ taskId: approvals.taskId, summary: approvals.summary });
}
