import { DatabaseSync } from "node:sqlite";

import { newId } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { SkillError } from "./package.mjs";

/**
 * Human approvals for skill installs, template saves and proposal installs.
 *
 * An approval is bound to one `kind` and one `subjectDigest` (the digest of
 * exactly what will be installed or saved), is resolved by a human — an
 * approver carrying an `agentId` is refused — who is not the requester, and
 * is consumed once. The same shape as the executor's action approvals, kept
 * in the skills database so the registry does not depend on a task.
 */
export function openSkillsDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

export function actorKey(actor) {
  if (typeof actor === "string" && actor) return `user:${actor}`;
  if (actor && typeof actor.agentId === "string" && actor.agentId) return `agent:${actor.agentId}`;
  if (actor && typeof actor.userId === "string" && actor.userId) return `user:${actor.userId}`;
  throw new SkillError("INVALID_ACTOR", "An actor needs a userId or agentId.");
}

/** A human approver is a user acting without an agent identity. */
export function requireHuman(actor, what = "approval") {
  if (!actor || (typeof actor === "object" && actor.agentId)) {
    throw new SkillError("HUMAN_APPROVAL_REQUIRED", `An ${what} must come from a human user, not an agent.`);
  }
  return actorKey(actor);
}

export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class SkillApprovals {
  #db;
  #clock;

  constructor({ db, clock = () => new Date() }) {
    this.#db = db;
    this.#clock = clock;
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_approvals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject_digest TEXT NOT NULL,
        summary TEXT,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
        resolved_by TEXT,
        resolved_at TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skill_approvals_tenant ON skill_approvals(tenant_id, status);
    `);
  }

  request({ tenantId, kind, subjectDigest, requestedBy, summary = null }) {
    if (!tenantId || !kind || !subjectDigest) throw new SkillError("INVALID_INPUT", "An approval request needs tenant, kind and subject digest.");
    const id = newId("approval");
    this.#db.prepare(
      `INSERT INTO skill_approvals (id, tenant_id, kind, subject_digest, summary, requested_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, tenantId, kind, subjectDigest, summary, actorKey(requestedBy), this.#clock().toISOString());
    return this.get(tenantId, id);
  }

  get(tenantId, id) {
    const row = this.#db.prepare("SELECT * FROM skill_approvals WHERE id = ? AND tenant_id = ?").get(id, tenantId);
    if (!row) return null;
    return {
      id: row.id, tenantId: row.tenant_id, kind: row.kind, subjectDigest: row.subject_digest, summary: row.summary,
      requestedBy: row.requested_by, status: row.status, resolvedBy: row.resolved_by, resolvedAt: row.resolved_at,
      consumed: row.consumed_at !== null, createdAt: row.created_at,
    };
  }

  resolve(tenantId, id, { approver, decision }) {
    const approverKey = requireHuman(approver);
    if (decision !== "approved" && decision !== "rejected") throw new SkillError("INVALID_INPUT", "decision must be 'approved' or 'rejected'.");
    const current = this.get(tenantId, id);
    if (!current) throw new SkillError("NOT_FOUND", "No such approval in this tenant.");
    if (current.status !== "pending") throw new SkillError("APPROVAL_RESOLVED", `Approval is already '${current.status}'.`);
    if (current.requestedBy === approverKey) throw new SkillError("SELF_APPROVAL", "The requester cannot approve their own request.");
    this.#db.prepare("UPDATE skill_approvals SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'")
      .run(decision, approverKey, this.#clock().toISOString(), id, tenantId);
    return this.get(tenantId, id);
  }

  /**
   * Returns null when `id` is an approved, unconsumed approval of this kind
   * for exactly this subject (and, when given, resolved by `approvedBy`);
   * otherwise a reason string. Does not consume.
   */
  problem(tenantId, id, { kind, subjectDigest, approvedBy = undefined }) {
    if (!id) return "no approval was supplied";
    const approval = this.get(tenantId, id);
    if (!approval) return "approval does not exist in this tenant";
    if (approval.kind !== kind) return `approval is for '${approval.kind}', not '${kind}'`;
    if (approval.subjectDigest !== subjectDigest) return "approval was granted for different content";
    if (approval.status !== "approved") return `approval is '${approval.status}', not approved`;
    if (approval.consumed) return "approval has already been used";
    if (approvedBy !== undefined && actorKey(approvedBy) !== approval.resolvedBy) return "approval was resolved by someone else";
    return null;
  }

  consume(tenantId, id) {
    const result = this.#db.prepare("UPDATE skill_approvals SET consumed_at = ? WHERE id = ? AND tenant_id = ? AND status = 'approved' AND consumed_at IS NULL")
      .run(this.#clock().toISOString(), id, tenantId);
    return Number(result.changes) === 1;
  }
}
