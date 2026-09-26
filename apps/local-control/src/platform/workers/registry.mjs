import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { RISK_LEVELS } from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Federated worker registry (blueprint §13 P).
 *
 * Workers are the machines that actually run browser, terminal, desktop and
 * model work: cloud workers, or local machines the owner has approved. A
 * worker registers what it can do; it earns trust only through the owner:
 *
 *   untrusted ──(owner approves enrollment)──▶ enrolled ──(owner verifies)──▶ verified
 *        any state ──(revoke)──▶ revoked (terminal; re-registration required)
 *
 * Scheduling picks an available worker that satisfies every capability the
 * task needs and whose trust meets the minimum for the task's risk. A worker
 * is available only while its heartbeat is fresh; a stale heartbeat makes it
 * unavailable without changing its trust. Every change is appended to an
 * audit table. All reads and writes are tenant-scoped.
 */

export const TRUST_LEVELS = Object.freeze(["untrusted", "enrolled", "verified"]);
export const WORKER_KINDS = Object.freeze(["cloud", "local"]);
/** Terminal isolation, weakest first. A task needing `container` can run on `container` or `vm`. */
export const TERMINAL_SANDBOX_LEVELS = Object.freeze(["none", "process", "container", "vm"]);
/** Minimum trust per task risk. Untrusted workers are never scheduled. */
export const DEFAULT_MIN_TRUST_BY_RISK = Object.freeze({
  read: "enrolled", low: "enrolled", moderate: "enrolled", high: "verified", critical: "verified",
});
export const DEFAULT_HEARTBEAT_TTL_MS = 60_000;

export class WorkerRegistryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "WorkerRegistryError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || !tenantId) throw new WorkerRegistryError("TENANT_REQUIRED", "A tenantId is required.");
}

function requireString(value, field) {
  if (typeof value !== "string" || !value) throw new WorkerRegistryError("INVALID_ARGUMENT", `'${field}' is required.`);
  return value;
}

/** Validates and canonicalizes a capability declaration. */
export function normalizeCapabilities(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkerRegistryError("INVALID_CAPABILITIES", "capabilities must be an object.");
  const terminal = value.terminal ?? [];
  const terminalLevels = Array.isArray(terminal) ? terminal : [terminal];
  for (const level of terminalLevels) {
    if (!TERMINAL_SANDBOX_LEVELS.includes(level)) throw new WorkerRegistryError("INVALID_CAPABILITIES", `Unknown terminal sandbox level '${level}'.`);
  }
  const gpu = value.gpu ?? null;
  if (gpu !== null && !(gpu && typeof gpu === "object" && Number.isFinite(gpu.vramGb) && gpu.vramGb >= 0)) {
    throw new WorkerRegistryError("INVALID_CAPABILITIES", "gpu must be { vramGb } or null.");
  }
  const models = value.models ?? [];
  if (!Array.isArray(models) || models.some((m) => typeof m !== "string" || !m)) throw new WorkerRegistryError("INVALID_CAPABILITIES", "models must be strings.");
  return {
    browser: value.browser === true,
    desktop: value.desktop === true,
    terminal: [...new Set(terminalLevels)].sort((a, b) => TERMINAL_SANDBOX_LEVELS.indexOf(a) - TERMINAL_SANDBOX_LEVELS.indexOf(b)),
    gpu: gpu ? { vramGb: gpu.vramGb } : null,
    models: [...new Set(models)].sort(),
  };
}

/** Returns the reasons `capabilities` do not meet `requirements` (empty = satisfied). */
export function capabilityGaps(capabilities, requirements = {}) {
  const gaps = [];
  if (requirements.browser && !capabilities.browser) gaps.push("no browser");
  if (requirements.desktop && !capabilities.desktop) gaps.push("no desktop");
  if (requirements.terminal) {
    const needed = TERMINAL_SANDBOX_LEVELS.indexOf(requirements.terminal);
    if (needed < 0) throw new WorkerRegistryError("INVALID_REQUIREMENTS", `Unknown terminal sandbox level '${requirements.terminal}'.`);
    if (!capabilities.terminal.some((level) => TERMINAL_SANDBOX_LEVELS.indexOf(level) >= needed)) {
      gaps.push(`no terminal sandbox at '${requirements.terminal}' or stronger (has ${capabilities.terminal.join(", ") || "none"})`);
    }
  }
  if (requirements.gpu) {
    const min = requirements.gpu.minVramGb ?? 0;
    if (!capabilities.gpu) gaps.push("no gpu");
    else if (capabilities.gpu.vramGb < min) gaps.push(`gpu ${capabilities.gpu.vramGb} GB < ${min} GB`);
  }
  for (const model of requirements.models ?? []) {
    if (!capabilities.models.includes(model)) gaps.push(`model '${model}' not available`);
  }
  return gaps;
}

export class WorkerRegistry {
  #db;
  #clock;
  #ttlMs;
  #isOwner;
  #minTrustByRisk;

  /**
   * @param options.isOwner ({ tenantId, userId }) => boolean — who may approve enrollment/verification/revocation
   * @param options.heartbeatTtlMs a heartbeat older than this makes a worker unavailable
   */
  constructor(filenameOrDb = ":memory:", { clock = () => new Date(), heartbeatTtlMs = DEFAULT_HEARTBEAT_TTL_MS, isOwner, minTrustByRisk = DEFAULT_MIN_TRUST_BY_RISK } = {}) {
    if (typeof isOwner !== "function") throw new WorkerRegistryError("INVALID_ARGUMENT", "isOwner is required: enrollment must be approved by the owner.");
    this.#db = typeof filenameOrDb === "string" ? new DatabaseSync(filenameOrDb) : filenameOrDb;
    this.#clock = clock;
    this.#ttlMs = heartbeatTtlMs;
    this.#isOwner = isOwner;
    this.#minTrustByRisk = { ...DEFAULT_MIN_TRUST_BY_RISK, ...minTrustByRisk };
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        capabilities TEXT NOT NULL, trust TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        registered_by TEXT, enrolled_by TEXT, verified_by TEXT, revoked_by TEXT, revoke_reason TEXT,
        last_heartbeat_at TEXT, load REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id));
      CREATE TABLE IF NOT EXISTS worker_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, worker_id TEXT NOT NULL,
        action TEXT NOT NULL, actor TEXT, detail TEXT, at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS worker_audit_no_update BEFORE UPDATE ON worker_audit BEGIN SELECT RAISE(ABORT, 'worker_audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS worker_audit_no_delete BEFORE DELETE ON worker_audit BEGIN SELECT RAISE(ABORT, 'worker_audit is append-only'); END;
    `);
  }

  close() { this.#db.close(); }
  #now() { return this.#clock().toISOString(); }

  #audit(tenantId, workerId, action, actor, detail = null) {
    this.#db.prepare("INSERT INTO worker_audit (tenant_id, worker_id, action, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tenantId, workerId, action, actor ?? null, detail === null ? null : JSON.stringify(detail), this.#now());
  }

  #hydrate(row) {
    if (!row) return null;
    const worker = {
      id: row.id, tenantId: row.tenant_id, name: row.name, kind: row.kind,
      capabilities: JSON.parse(row.capabilities), trust: row.trust, revoked: Boolean(row.revoked),
      registeredBy: row.registered_by, enrolledBy: row.enrolled_by, verifiedBy: row.verified_by,
      revokedBy: row.revoked_by, revokeReason: row.revoke_reason,
      lastHeartbeatAt: row.last_heartbeat_at, load: row.load, createdAt: row.created_at, updatedAt: row.updated_at,
    };
    worker.availability = this.availability(worker);
    return worker;
  }

  /** `{ available, reason }` for one worker at the current clock. */
  availability(worker) {
    if (worker.revoked) return { available: false, reason: "revoked" };
    if (worker.trust === "untrusted") return { available: false, reason: "not enrolled" };
    if (!worker.lastHeartbeatAt) return { available: false, reason: "no heartbeat yet" };
    const age = this.#clock().getTime() - Date.parse(worker.lastHeartbeatAt);
    if (age > this.#ttlMs) return { available: false, reason: `heartbeat stale (${age} ms > ${this.#ttlMs} ms)` };
    return { available: true, reason: "heartbeat fresh" };
  }

  getWorker(tenantId, workerId) {
    requireTenant(tenantId);
    return this.#hydrate(this.#db.prepare("SELECT * FROM workers WHERE tenant_id = ? AND id = ?").get(tenantId, workerId));
  }

  requireWorker(tenantId, workerId) {
    const worker = this.getWorker(tenantId, workerId);
    if (!worker) throw new WorkerRegistryError("WORKER_NOT_FOUND", `Worker '${workerId}' does not exist in this tenant.`);
    return worker;
  }

  listWorkers(tenantId, { includeRevoked = false } = {}) {
    requireTenant(tenantId);
    return this.#db.prepare("SELECT * FROM workers WHERE tenant_id = ? ORDER BY created_at, rowid").all(tenantId)
      .map((row) => this.#hydrate(row)).filter((w) => includeRevoked || !w.revoked);
  }

  auditTrail(tenantId, workerId) {
    requireTenant(tenantId);
    return this.#db.prepare("SELECT action, actor, detail, at FROM worker_audit WHERE tenant_id = ? AND worker_id = ? ORDER BY seq").all(tenantId, workerId)
      .map((r) => ({ action: r.action, actor: r.actor, detail: r.detail === null ? null : JSON.parse(r.detail), at: r.at }));
  }

  /** A worker announces itself. It starts untrusted and cannot be scheduled until the owner enrolls it. */
  register({ tenantId, name, kind, capabilities, registeredBy = null }) {
    requireTenant(tenantId);
    requireString(name, "name");
    if (!WORKER_KINDS.includes(kind)) throw new WorkerRegistryError("INVALID_ARGUMENT", `kind must be one of ${WORKER_KINDS.join(", ")}.`);
    const caps = normalizeCapabilities(capabilities);
    const id = `wkr_${randomUUID().replaceAll("-", "")}`;
    const at = this.#now();
    this.#db.prepare(`INSERT INTO workers (tenant_id, id, name, kind, capabilities, trust, registered_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'untrusted', ?, ?, ?)`).run(tenantId, id, name, kind, JSON.stringify(caps), registeredBy, at, at);
    this.#audit(tenantId, id, "registered", registeredBy, { kind, capabilities: caps });
    return this.getWorker(tenantId, id);
  }

  #requireOwner(tenantId, userId, action) {
    requireString(userId, "approver");
    if (this.#isOwner({ tenantId, userId }) !== true) {
      this.#audit(tenantId, "-", `${action}.refused`, userId, { reason: "not owner" });
      throw new WorkerRegistryError("NOT_OWNER", `Only the tenant owner can ${action} a worker.`);
    }
  }

  #requireActive(worker) {
    if (worker.revoked) throw new WorkerRegistryError("WORKER_REVOKED", `Worker '${worker.id}' has been revoked; it must register again.`);
  }

  /** Owner approval: untrusted → enrolled. */
  approveEnrollment(tenantId, workerId, { approver }) {
    this.#requireOwner(tenantId, approver, "enroll");
    const worker = this.requireWorker(tenantId, workerId);
    this.#requireActive(worker);
    if (worker.trust !== "untrusted") throw new WorkerRegistryError("ILLEGAL_TRUST_TRANSITION", `Worker is already '${worker.trust}'.`);
    this.#db.prepare("UPDATE workers SET trust = 'enrolled', enrolled_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(approver, this.#now(), tenantId, workerId);
    this.#audit(tenantId, workerId, "enrolled", approver);
    return this.getWorker(tenantId, workerId);
  }

  /** Owner verification (e.g. after attestation evidence): enrolled → verified. */
  verifyWorker(tenantId, workerId, { verifier, evidence = null }) {
    this.#requireOwner(tenantId, verifier, "verify");
    const worker = this.requireWorker(tenantId, workerId);
    this.#requireActive(worker);
    if (worker.trust !== "enrolled") throw new WorkerRegistryError("ILLEGAL_TRUST_TRANSITION", `Only an enrolled worker can be verified (is '${worker.trust}').`);
    this.#db.prepare("UPDATE workers SET trust = 'verified', verified_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(verifier, this.#now(), tenantId, workerId);
    this.#audit(tenantId, workerId, "verified", verifier, evidence);
    return this.getWorker(tenantId, workerId);
  }

  heartbeat(tenantId, workerId, { load = 0, capabilities = undefined } = {}) {
    const worker = this.requireWorker(tenantId, workerId);
    this.#requireActive(worker);
    if (!(Number.isFinite(load) && load >= 0 && load <= 1)) throw new WorkerRegistryError("INVALID_ARGUMENT", "load must be between 0 and 1.");
    let caps = worker.capabilities;
    if (capabilities !== undefined) {
      caps = normalizeCapabilities(capabilities);
      // A heartbeat may shrink capabilities (a GPU went away) but never grow them:
      // new capabilities need a fresh registration and owner enrollment.
      const grew = capabilityGaps(worker.capabilities, requirementsFrom(caps));
      if (grew.length) throw new WorkerRegistryError("CAPABILITY_GROWTH", `A heartbeat cannot add capabilities (${grew.join("; ")}).`);
    }
    this.#db.prepare("UPDATE workers SET last_heartbeat_at = ?, load = ?, capabilities = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(this.#now(), load, JSON.stringify(caps), this.#now(), tenantId, workerId);
    return this.getWorker(tenantId, workerId);
  }

  revoke(tenantId, workerId, { by, reason = "revoked" }) {
    this.#requireOwner(tenantId, by, "revoke");
    const worker = this.requireWorker(tenantId, workerId);
    if (worker.revoked) return worker;
    this.#db.prepare("UPDATE workers SET revoked = 1, revoked_by = ?, revoke_reason = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(by, reason, this.#now(), tenantId, workerId);
    this.#audit(tenantId, workerId, "revoked", by, { reason });
    return this.getWorker(tenantId, workerId);
  }

  minimumTrustFor(risk) {
    if (!RISK_LEVELS.includes(risk)) throw new WorkerRegistryError("INVALID_ARGUMENT", `Unknown risk '${risk}'.`);
    return this.#minTrustByRisk[risk];
  }

  /**
   * Picks a worker for one task.
   * @param input.requirements { browser?, desktop?, terminal?: sandbox level, gpu?: { minVramGb }, models?: string[], local?: boolean }
   * @param input.risk one of RISK_LEVELS
   * @returns { worker, reason, rejected: [{ id, reasons }] } — worker is null when none qualifies
   */
  schedule({ tenantId, requirements = {}, risk = "moderate" }) {
    const minTrust = this.minimumTrustFor(risk);
    const minRank = TRUST_LEVELS.indexOf(minTrust);
    const qualified = [];
    const rejected = [];
    for (const worker of this.listWorkers(tenantId, { includeRevoked: true })) {
      const reasons = [];
      if (!worker.availability.available) reasons.push(`unavailable: ${worker.availability.reason}`);
      if (TRUST_LEVELS.indexOf(worker.trust) < minRank) reasons.push(`trust '${worker.trust}' below '${minTrust}' required for ${risk} risk`);
      if (requirements.local === true && worker.kind !== "local") reasons.push("task must run on a local machine");
      reasons.push(...capabilityGaps(worker.capabilities, requirements));
      if (reasons.length) rejected.push({ id: worker.id, name: worker.name, reasons });
      else qualified.push(worker);
    }
    // Prefer the least loaded, then higher trust, then the freshest heartbeat.
    qualified.sort((a, b) => a.load - b.load
      || TRUST_LEVELS.indexOf(b.trust) - TRUST_LEVELS.indexOf(a.trust)
      || Date.parse(b.lastHeartbeatAt) - Date.parse(a.lastHeartbeatAt)
      || a.id.localeCompare(b.id));
    const worker = qualified[0] ?? null;
    return {
      worker,
      minimumTrust: minTrust,
      reason: worker
        ? `${worker.name} (${worker.kind}, ${worker.trust}, load ${worker.load}) meets every requirement for a ${risk}-risk task; ${qualified.length - 1} other qualified`
        : `no worker satisfies the requirements for a ${risk}-risk task`,
      rejected,
    };
  }
}

function requirementsFrom(caps) {
  return {
    browser: caps.browser, desktop: caps.desktop,
    terminal: caps.terminal.at(-1),
    gpu: caps.gpu ? { minVramGb: caps.gpu.vramGb } : undefined,
    models: caps.models,
  };
}
