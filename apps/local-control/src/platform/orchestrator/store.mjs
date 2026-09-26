import { DatabaseSync } from "node:sqlite";

import { newId } from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Durable orchestration state that sits beside the PlatformTaskStore
 * (blueprint §3, §11, §12, Phase 7).
 *
 * The task store owns tasks, tool calls, approvals, artifacts and the event
 * log. Orchestration adds things the task store has no tables for — task
 * dependencies, deadlines, leases, checkpoints, control flags and
 * escalations — and keeps them in its own
 * SQLite database so it never reaches into the task store's private
 * connection. Every tenant-owned row carries `tenant_id` and every read filters
 * on it, matching the task store's isolation rule.
 *
 * Event delivery and child scheduling are NOT reimplemented here: events
 * flow through platform/outbox-dispatcher.mjs and in-process child execution
 * through agent/mission-scheduler.mjs. This module only adds the durable
 * state those two do not keep.
 */
export class OrchestratorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new OrchestratorError("TENANT_REQUIRED", "Every orchestrator read and write must name its tenant.");
  }
}

const parse = (text, fallback = null) => (text === null || text === undefined ? fallback : JSON.parse(text));

export const ESCALATION_SOURCES = Object.freeze(["outbox", "agent_loop", "recovery", "dag", "operator"]);

export class OrchestratorStore {
  #db;
  #clock;
  #txDepth = 0;

  constructor(filename = ":memory:", { clock = () => new Date() } = {}) {
    this.#db = new DatabaseSync(filename);
    this.#clock = clock;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS task_dependencies (
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, task_id, depends_on_task_id)
      );
      CREATE INDEX IF NOT EXISTS task_dependencies_rev_idx ON task_dependencies(tenant_id, depends_on_task_id);
      CREATE TABLE IF NOT EXISTS task_deadlines (
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS task_leases (
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS task_controls (
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        recoveries INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        actor TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS escalations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        task_id TEXT,
        correlation_id TEXT,
        source TEXT NOT NULL,
        source_ref TEXT,
        reason TEXT NOT NULL,
        details_json TEXT NOT NULL,
        requires_human INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        resolved_by TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS escalations_ref_idx ON escalations(source, source_ref) WHERE source_ref IS NOT NULL;
      CREATE INDEX IF NOT EXISTS escalations_tenant_idx ON escalations(tenant_id, status, created_at);
    `);
  }

  get db() { return this.#db; }
  now() { return this.#clock().toISOString(); }
  nowMs() { return this.#clock().getTime(); }
  close() { this.#db.close(); }

  /** Synchronous IMMEDIATE transaction; nested calls join the outer one. */
  transaction(fn) {
    if (this.#txDepth > 0) {
      this.#txDepth += 1;
      try { return fn(); } finally { this.#txDepth -= 1; }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#txDepth = 1;
    try {
      const result = fn();
      if (result && typeof result.then === "function") throw new OrchestratorError("ASYNC_TRANSACTION", "Transactions must be synchronous.");
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#txDepth = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Escalations: records that a human must look at something.
  // -------------------------------------------------------------------------

  /**
   * Opens an escalation. `sourceRef` makes it idempotent: a second escalation
   * for the same (source, sourceRef) returns the first instead of duplicating.
   */
  createEscalation({ tenantId, taskId = null, correlationId = null, source, sourceRef = null, reason, details = {} }) {
    requireTenant(tenantId);
    if (!ESCALATION_SOURCES.includes(source)) throw new OrchestratorError("INVALID_ESCALATION", `Unknown escalation source '${source}'.`);
    if (typeof reason !== "string" || !reason) throw new OrchestratorError("INVALID_ESCALATION", "An escalation needs a reason.");
    return this.transaction(() => {
      if (sourceRef !== null) {
        const existing = this.#db.prepare("SELECT * FROM escalations WHERE source = ? AND source_ref = ?").get(source, sourceRef);
        if (existing) return this.#escalationFromRow(existing);
      }
      const id = `esc_${newId("event").slice(4)}`;
      const now = this.now();
      this.#db.prepare(
        `INSERT INTO escalations (id, tenant_id, task_id, correlation_id, source, source_ref, reason, details_json, requires_human, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?)`,
      ).run(id, tenantId, taskId, correlationId, source, sourceRef, reason.slice(0, 500), JSON.stringify(details), now);
      return this.getEscalation(tenantId, id);
    });
  }

  #escalationFromRow(row) {
    return {
      id: row.id,
      type: "ESCALATION",
      tenantId: row.tenant_id,
      taskId: row.task_id,
      correlationId: row.correlation_id,
      source: row.source,
      sourceRef: row.source_ref,
      reason: row.reason,
      details: parse(row.details_json, {}),
      requiresHuman: row.requires_human === 1,
      status: row.status,
      resolvedBy: row.resolved_by,
      resolution: row.resolution,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  getEscalation(tenantId, id) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT * FROM escalations WHERE id = ? AND tenant_id = ?").get(id, tenantId);
    return row ? this.#escalationFromRow(row) : null;
  }

  listEscalations(tenantId, { taskId = undefined, status = undefined, source = undefined } = {}) {
    requireTenant(tenantId);
    const clauses = ["tenant_id = ?"];
    const params = [tenantId];
    if (taskId !== undefined) { clauses.push("task_id = ?"); params.push(taskId); }
    if (status !== undefined) { clauses.push("status = ?"); params.push(status); }
    if (source !== undefined) { clauses.push("source = ?"); params.push(source); }
    return this.#db.prepare(`SELECT * FROM escalations WHERE ${clauses.join(" AND ")} ORDER BY created_at, rowid`).all(...params)
      .map((row) => this.#escalationFromRow(row));
  }

  /** Only a named human closes an escalation. */
  resolveEscalation(tenantId, id, { resolvedBy, resolution }) {
    requireTenant(tenantId);
    if (!resolvedBy) throw new OrchestratorError("RESOLVER_REQUIRED", "Resolving an escalation must record who resolved it.");
    const result = this.#db.prepare(
      "UPDATE escalations SET status = 'resolved', resolved_by = ?, resolution = ?, resolved_at = ? WHERE id = ? AND tenant_id = ? AND status = 'open'",
    ).run(resolvedBy, resolution ?? null, this.now(), id, tenantId);
    if (Number(result.changes) !== 1) throw new OrchestratorError("NOT_OPEN", "No open escalation with that id in this tenant.");
    return this.getEscalation(tenantId, id);
  }

  // -------------------------------------------------------------------------
  // Leases: which worker is actively driving a task right now.
  // -------------------------------------------------------------------------

  /** Takes or renews the lease. Refused while another owner's lease is live. */
  acquireLease(tenantId, taskId, owner, ttlMs) {
    requireTenant(tenantId);
    return this.transaction(() => {
      const now = this.now();
      const row = this.#db.prepare("SELECT * FROM task_leases WHERE tenant_id = ? AND task_id = ?").get(tenantId, taskId);
      if (row && row.owner !== owner && row.expires_at > now) return false;
      const expiresAt = new Date(this.nowMs() + ttlMs).toISOString();
      this.#db.prepare(
        `INSERT INTO task_leases (tenant_id, task_id, owner, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, task_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
      ).run(tenantId, taskId, owner, expiresAt);
      return true;
    });
  }

  releaseLease(tenantId, taskId, owner = undefined) {
    requireTenant(tenantId);
    if (owner === undefined) this.#db.prepare("DELETE FROM task_leases WHERE tenant_id = ? AND task_id = ?").run(tenantId, taskId);
    else this.#db.prepare("DELETE FROM task_leases WHERE tenant_id = ? AND task_id = ? AND owner = ?").run(tenantId, taskId, owner);
  }

  getLease(tenantId, taskId) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT * FROM task_leases WHERE tenant_id = ? AND task_id = ?").get(tenantId, taskId);
    if (!row) return null;
    return { tenantId, taskId, owner: row.owner, expiresAt: row.expires_at, live: row.expires_at > this.now() };
  }

  /** Tenants the orchestrator has seen, used to scope restart recovery. */
  knownTenants() {
    return this.#db.prepare(
      `SELECT tenant_id FROM task_leases UNION SELECT tenant_id FROM task_checkpoints UNION SELECT tenant_id FROM task_controls
       UNION SELECT tenant_id FROM task_dependencies`,
    ).all().map((row) => row.tenant_id);
  }

  // -------------------------------------------------------------------------
  // Checkpoints and control flags
  // -------------------------------------------------------------------------

  saveCheckpoint(tenantId, taskId, state) {
    requireTenant(tenantId);
    this.#db.prepare(
      `INSERT INTO task_checkpoints (tenant_id, task_id, state_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, task_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    ).run(tenantId, taskId, JSON.stringify(state), this.now());
  }

  loadCheckpoint(tenantId, taskId) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT state_json FROM task_checkpoints WHERE tenant_id = ? AND task_id = ?").get(tenantId, taskId);
    return row ? parse(row.state_json) : null;
  }

  clearCheckpoint(tenantId, taskId) {
    requireTenant(tenantId);
    this.#db.prepare("DELETE FROM task_checkpoints WHERE tenant_id = ? AND task_id = ?").run(tenantId, taskId);
  }

  getControl(tenantId, taskId) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT * FROM task_controls WHERE tenant_id = ? AND task_id = ?").get(tenantId, taskId);
    return {
      paused: row?.paused === 1,
      cancelRequested: row?.cancel_requested === 1,
      recoveries: row?.recoveries ?? 0,
      reason: row?.reason ?? null,
      actor: row?.actor ?? null,
    };
  }

  setControl(tenantId, taskId, { paused = undefined, cancelRequested = undefined, recoveries = undefined, reason = undefined, actor = undefined }) {
    requireTenant(tenantId);
    const current = this.getControl(tenantId, taskId);
    const next = {
      paused: paused ?? current.paused,
      cancelRequested: cancelRequested ?? current.cancelRequested,
      recoveries: recoveries ?? current.recoveries,
      reason: reason === undefined ? current.reason : reason,
      actor: actor === undefined ? current.actor : actor,
    };
    this.#db.prepare(
      `INSERT INTO task_controls (tenant_id, task_id, paused, cancel_requested, recoveries, reason, actor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, task_id) DO UPDATE SET paused = excluded.paused, cancel_requested = excluded.cancel_requested,
         recoveries = excluded.recoveries, reason = excluded.reason, actor = excluded.actor, updated_at = excluded.updated_at`,
    ).run(tenantId, taskId, next.paused ? 1 : 0, next.cancelRequested ? 1 : 0, next.recoveries, next.reason, next.actor, this.now());
    return next;
  }
}
