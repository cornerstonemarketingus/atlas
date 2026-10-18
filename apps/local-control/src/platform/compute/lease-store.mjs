import { DatabaseSync } from "node:sqlite";

/**
 * Durable GPU leases and their audit trail (node:sqlite).
 *
 * A lease is written BEFORE the provider is asked for an instance and is the
 * only thing that makes an Atlas-tagged instance legitimate: the reconciler
 * terminates any tagged instance without a live lease. Every user-facing read
 * takes a tenantId; the reconciler's whole-database scans are maintenance.
 *
 * States: provisioning -> running -> terminating -> settling -> settled.
 * `terminating` and `settling` are retried by the reconciler until done.
 * Times are integer milliseconds from the manager's clock.
 */

export const LEASE_STATES = Object.freeze(["provisioning", "running", "terminating", "settling", "settled"]);
export const ACTIVE_STATES = Object.freeze(["provisioning", "running"]);
export const PENDING_STATES = Object.freeze(["terminating", "settling"]);

/** Audit detail fields that may be stored; anything else (a token, a provider payload) is dropped. */
const AUDIT_FIELDS = Object.freeze([
  "jobId", "taskId", "provider", "gpuType", "instanceId", "reason", "outcome", "reservedMicroUsd", "actualMicroUsd",
  "releasedMicroUsd", "excessMicroUsd", "maxLifetimeSec", "estHourlyUsd", "estMinutes", "error", "holder", "unattributed",
]);

function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || !tenantId) throw new Error("A tenantId is required.");
}

function fromRow(row) {
  if (!row) return null;
  return {
    tenantId: row.tenant_id, id: row.id, jobId: row.job_id, taskId: row.task_id, provider: row.provider, gpuType: row.gpu_type,
    instanceId: row.instance_id, state: row.state, holder: row.holder,
    reservedMicroUsd: row.reserved_micro_usd, rateMicroUsdPerSec: row.rate_micro_usd_per_sec,
    maxLifetimeSec: row.max_lifetime_sec, idleTimeoutSec: row.idle_timeout_sec,
    createdAt: row.created_at, provisionedAt: row.provisioned_at, lastHeartbeatAt: row.last_heartbeat_at,
    leaseExpiresAt: row.lease_expires_at, deadlineAt: row.deadline_at, endedAt: row.ended_at, endReason: row.end_reason,
    actualMicroUsd: row.actual_micro_usd, releasedMicroUsd: row.released_micro_usd, excessMicroUsd: row.excess_micro_usd,
  };
}

export class ComputeLeaseStore {
  #db;

  constructor(filenameOrDb = ":memory:") {
    this.#db = typeof filenameOrDb === "string" ? new DatabaseSync(filenameOrDb) : filenameOrDb;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS compute_leases (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL, task_id TEXT NOT NULL,
        provider TEXT NOT NULL, gpu_type TEXT NOT NULL, instance_id TEXT, state TEXT NOT NULL, holder TEXT NOT NULL,
        reserved_micro_usd INTEGER NOT NULL, rate_micro_usd_per_sec INTEGER NOT NULL,
        max_lifetime_sec INTEGER NOT NULL, idle_timeout_sec INTEGER NOT NULL,
        created_at INTEGER NOT NULL, provisioned_at INTEGER, last_heartbeat_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
        ended_at INTEGER, end_reason TEXT, actual_micro_usd INTEGER, released_micro_usd INTEGER, excess_micro_usd INTEGER,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE INDEX IF NOT EXISTS compute_leases_state ON compute_leases (state);
      CREATE UNIQUE INDEX IF NOT EXISTS compute_leases_instance ON compute_leases (provider, instance_id) WHERE instance_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS compute_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, lease_id TEXT, action TEXT NOT NULL,
        at INTEGER NOT NULL, details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS compute_audit_tenant ON compute_audit (tenant_id, seq);
    `);
  }

  close() { this.#db.close(); }

  insert(lease) {
    requireTenant(lease.tenantId);
    this.#db.prepare(`INSERT INTO compute_leases (tenant_id, id, job_id, task_id, provider, gpu_type, instance_id, state, holder,
      reserved_micro_usd, rate_micro_usd_per_sec, max_lifetime_sec, idle_timeout_sec, created_at, last_heartbeat_at, lease_expires_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      lease.tenantId, lease.id, lease.jobId, lease.taskId, lease.provider, lease.gpuType, lease.holder,
      lease.reservedMicroUsd, lease.rateMicroUsdPerSec, lease.maxLifetimeSec, lease.idleTimeoutSec,
      lease.createdAt, lease.createdAt, lease.leaseExpiresAt, lease.deadlineAt);
    return this.get(lease.tenantId, lease.id);
  }

  get(tenantId, id) {
    requireTenant(tenantId);
    return fromRow(this.#db.prepare("SELECT * FROM compute_leases WHERE tenant_id = ? AND id = ?").get(tenantId, id));
  }

  list(tenantId, { state = undefined } = {}) {
    requireTenant(tenantId);
    const rows = state
      ? this.#db.prepare("SELECT * FROM compute_leases WHERE tenant_id = ? AND state = ? ORDER BY created_at").all(tenantId, state)
      : this.#db.prepare("SELECT * FROM compute_leases WHERE tenant_id = ? ORDER BY created_at").all(tenantId);
    return rows.map(fromRow);
  }

  /** Maintenance scan across tenants for the reconciler. */
  listByStates(states) {
    const marks = states.map(() => "?").join(", ");
    return this.#db.prepare(`SELECT * FROM compute_leases WHERE state IN (${marks}) ORDER BY created_at`).all(...states).map(fromRow);
  }

  /** Applies `fields` only if the lease is still in one of `fromStates`; returns the updated lease or null. */
  update(tenantId, id, fromStates, fields) {
    requireTenant(tenantId);
    const columns = {
      instanceId: "instance_id", state: "state", provisionedAt: "provisioned_at", lastHeartbeatAt: "last_heartbeat_at",
      leaseExpiresAt: "lease_expires_at", endedAt: "ended_at", endReason: "end_reason", actualMicroUsd: "actual_micro_usd",
      releasedMicroUsd: "released_micro_usd", excessMicroUsd: "excess_micro_usd",
    };
    const sets = []; const params = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!columns[key]) throw new Error(`Unknown lease field '${key}'.`);
      sets.push(`${columns[key]} = ?`); params.push(value);
    }
    const marks = fromStates.map(() => "?").join(", ");
    const { changes } = this.#db.prepare(`UPDATE compute_leases SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ? AND state IN (${marks})`)
      .run(...params, tenantId, id, ...fromStates);
    return changes ? this.get(tenantId, id) : null;
  }

  audit(tenantId, leaseId, action, at, details = {}) {
    requireTenant(tenantId);
    const safe = {};
    for (const field of AUDIT_FIELDS) if (details[field] !== undefined) safe[field] = details[field];
    if (typeof safe.error === "string") safe.error = safe.error.slice(0, 200);
    this.#db.prepare("INSERT INTO compute_audit (tenant_id, lease_id, action, at, details_json) VALUES (?, ?, ?, ?, ?)")
      .run(tenantId, leaseId ?? null, action, at, JSON.stringify(safe));
  }

  listAudit(tenantId, { leaseId = undefined } = {}) {
    requireTenant(tenantId);
    const rows = leaseId === undefined
      ? this.#db.prepare("SELECT * FROM compute_audit WHERE tenant_id = ? ORDER BY seq").all(tenantId)
      : this.#db.prepare("SELECT * FROM compute_audit WHERE tenant_id = ? AND lease_id = ? ORDER BY seq").all(tenantId, leaseId);
    return rows.map(row => ({ seq: row.seq, tenantId: row.tenant_id, leaseId: row.lease_id, action: row.action, at: row.at, details: JSON.parse(row.details_json) }));
  }

  /** Raw dump for leak tests. */
  dumpText() {
    return JSON.stringify([
      this.#db.prepare("SELECT * FROM compute_leases").all(),
      this.#db.prepare("SELECT * FROM compute_audit").all(),
    ]);
  }
}
