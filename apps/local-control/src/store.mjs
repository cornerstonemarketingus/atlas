import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export class LocalTaskStore {
  #db;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS local_tasks (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        objective TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS local_tasks_created_at_idx
        ON local_tasks(created_at DESC);
      CREATE TABLE IF NOT EXISTS local_policies (capability TEXT PRIMARY KEY, decision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_approvals (id TEXT PRIMARY KEY, task_id TEXT, capability TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL, resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS local_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS local_pairing_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS local_audit (id TEXT PRIMARY KEY, category TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_infrastructure_plans (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        digest TEXT NOT NULL,
        capability TEXT NOT NULL,
        preview TEXT NOT NULL,
        input TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        executed_at TEXT,
        FOREIGN KEY(approval_id) REFERENCES local_approvals(id)
      );
      CREATE TABLE IF NOT EXISTS local_task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES local_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS local_task_events_task_sequence_idx
        ON local_task_events(task_id, sequence);
      INSERT OR IGNORE INTO local_policies (capability, decision) VALUES ('code.write', 'ask'), ('computer.high_risk', 'ask'), ('publish.remote', 'ask'), ('repository.read', 'allow');
    `);
    this.#db.prepare("UPDATE local_tasks SET status = 'interrupted', message = 'Atlas restarted while this task was running.', completed_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
  }

  create({ repository, objective, model, status = "queued" }) {
    const task = {
      id: randomUUID(), repository, objective, model, status,
      message: null, createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    };
    this.#db.prepare("INSERT INTO local_tasks (id, repository, objective, model, status, message, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.repository, task.objective, task.model, task.status, task.message, task.createdAt, task.startedAt, task.completedAt);
    return task;
  }

  list(limit = 50) {
    return this.#db.prepare("SELECT id, repository, objective, model, status, message, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt FROM local_tasks ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }

  get(id) {
    return this.#db.prepare("SELECT id, repository, objective, model, status, message, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt FROM local_tasks WHERE id = ?")
      .get(id) ?? null;
  }

  markRunning(id) {
    this.#db.prepare("UPDATE local_tasks SET status = 'running', started_at = ?, message = NULL WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.get(id);
  }

  setStatus(id, status, message = null) { this.#db.prepare("UPDATE local_tasks SET status = ?, message = ? WHERE id = ?").run(status, message, id); return this.get(id); }

  transition(id, from, status, message = null) {
    const allowed = Array.isArray(from) ? from : [from];
    if (!allowed.length) return null;
    const placeholders = allowed.map(() => "?").join(",");
    const result = this.#db.prepare(`UPDATE local_tasks SET status = ?, message = ?, completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE NULL END WHERE id = ? AND status IN (${placeholders})`)
      .run(status, message, status, new Date().toISOString(), id, ...allowed);
    return result.changes ? this.get(id) : null;
  }

  appendEvent(taskId, type, payload = {}) {
    if (!this.get(taskId)) throw new Error("Task not found.");
    if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(type)) throw new Error("Invalid event type.");
    const encoded = JSON.stringify(payload ?? {});
    if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new Error("Task event is too large.");
    const createdAt = new Date().toISOString();
    const result = this.#db.prepare("INSERT INTO local_task_events (task_id,type,payload,created_at) VALUES (?,?,?,?)").run(taskId, type, encoded, createdAt);
    return { sequence: Number(result.lastInsertRowid), taskId, type, payload: JSON.parse(encoded), createdAt };
  }

  events(taskId, after = 0, limit = 500) {
    const safeAfter = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 500;
    return this.#db.prepare("SELECT sequence,task_id AS taskId,type,payload,created_at AS createdAt FROM local_task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?")
      .all(taskId, safeAfter, safeLimit).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  allEvents(limit = 100_000) {
    return this.#db.prepare("SELECT sequence,task_id AS taskId,type,payload,created_at AS createdAt FROM local_task_events ORDER BY sequence ASC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 100_000)).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  policies() { return this.#db.prepare("SELECT capability, decision FROM local_policies ORDER BY capability").all(); }
  policy(capability) { return this.#db.prepare("SELECT capability, decision FROM local_policies WHERE capability = ?").get(capability) ?? { capability, decision: "deny" }; }
  setPolicy(capability, decision) {
    if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(capability) || !["allow", "ask", "deny"].includes(decision)) throw new Error("Invalid policy.");
    this.#db.prepare("INSERT INTO local_policies (capability, decision) VALUES (?, ?) ON CONFLICT(capability) DO UPDATE SET decision = excluded.decision").run(capability, decision);
    this.audit("policy.changed", `${capability}=${decision}`); return this.policy(capability);
  }

  createApproval({ taskId = null, capability, summary }) { const row = { id: randomUUID(), taskId, capability, summary, status: "pending", requestedAt: new Date().toISOString(), resolvedAt: null }; this.#db.prepare("INSERT INTO local_approvals VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.id, row.taskId, row.capability, row.summary, row.status, row.requestedAt, row.resolvedAt); this.audit("approval.requested", `${capability}: ${summary}`); return row; }
  approvals() { return this.#db.prepare("SELECT id, task_id AS taskId, capability, summary, status, requested_at AS requestedAt, resolved_at AS resolvedAt FROM local_approvals ORDER BY requested_at DESC").all(); }
  approval(id) { return this.#db.prepare("SELECT id, task_id AS taskId, capability, summary, status, requested_at AS requestedAt, resolved_at AS resolvedAt FROM local_approvals WHERE id = ?").get(id) ?? null; }
  decideApproval(id, decision) { if (!['approved','denied'].includes(decision)) throw new Error("Invalid approval decision."); const current = this.approval(id); if (!current || current.status !== 'pending') return null; this.#db.prepare("UPDATE local_approvals SET status = ?, resolved_at = ? WHERE id = ?").run(decision, new Date().toISOString(), id); this.audit("approval.decided", `${id}=${decision}`); return this.approval(id); }

  addPairingCode(codeHash, expiresAt) { this.#db.prepare("INSERT INTO local_pairing_codes VALUES (?, ?, NULL)").run(codeHash, expiresAt); }
  consumePairingCode(codeHash, now) { const row = this.#db.prepare("SELECT code_hash AS codeHash FROM local_pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").get(codeHash, now); if (!row) return false; this.#db.prepare("UPDATE local_pairing_codes SET used_at = ? WHERE code_hash = ?").run(now, codeHash); return true; }
  addDevice(name, tokenHash) { const row = { id: randomUUID(), name, tokenHash, createdAt: new Date().toISOString() }; this.#db.prepare("INSERT INTO local_devices (id,name,token_hash,created_at,revoked_at) VALUES (?,?,?,?,NULL)").run(row.id,row.name,row.tokenHash,row.createdAt); this.audit("device.paired", name); return { id: row.id, name: row.name, createdAt: row.createdAt }; }
  deviceByTokenHash(tokenHash) { return this.#db.prepare("SELECT id,name,created_at AS createdAt FROM local_devices WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash) ?? null; }
  devices() { return this.#db.prepare("SELECT id,name,created_at AS createdAt,revoked_at AS revokedAt FROM local_devices ORDER BY created_at DESC").all(); }
  revokeDevice(id) { const result = this.#db.prepare("UPDATE local_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id); if (!result.changes) return null; this.audit("device.revoked", id); return this.devices().find((device) => device.id === id); }

  audit(category, summary) { this.#db.prepare("INSERT INTO local_audit VALUES (?, ?, ?, ?)").run(randomUUID(), category, String(summary).slice(0, 2000), new Date().toISOString()); }
  auditEvents(limit = 200) { return this.#db.prepare("SELECT id,category,summary,created_at AS createdAt FROM local_audit ORDER BY created_at DESC LIMIT ?").all(limit); }
  snapshot() { return { version: 1, exportedAt: new Date().toISOString(), tasks: this.list(10_000), policies: this.policies(), approvals: this.approvals(), audit: this.auditEvents(10_000), events: this.allEvents() }; }
  importSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !["tasks", "policies", "approvals", "audit"].every((key) => Array.isArray(snapshot[key]))) throw new Error("Invalid Atlas backup data.");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#db.prepare("INSERT OR IGNORE INTO local_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const row of snapshot.tasks) { const status = row.status === "running" ? "interrupted" : row.status; task.run(row.id, row.repository, row.objective, row.model, status, status === "interrupted" ? "Imported task was running when exported." : row.message ?? null, row.createdAt, row.startedAt ?? null, row.completedAt ?? null); }
      const policy = this.#db.prepare("INSERT INTO local_policies (capability,decision) VALUES (?,?) ON CONFLICT(capability) DO UPDATE SET decision=excluded.decision");
      for (const row of snapshot.policies) { if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(row.capability) || !["allow", "ask", "deny"].includes(row.decision)) throw new Error("Invalid policy in backup."); policy.run(row.capability, row.decision); }
      const approval = this.#db.prepare("INSERT OR IGNORE INTO local_approvals VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const row of snapshot.approvals) approval.run(row.id, row.taskId ?? null, row.capability, row.summary, row.status, row.requestedAt, row.resolvedAt ?? null);
      const audit = this.#db.prepare("INSERT OR IGNORE INTO local_audit VALUES (?, ?, ?, ?)");
      for (const row of snapshot.audit) audit.run(row.id, row.category, row.summary, row.createdAt);
      const event = this.#db.prepare("INSERT OR IGNORE INTO local_task_events (sequence,task_id,type,payload,created_at) VALUES (?,?,?,?,?)");
      for (const row of snapshot.events ?? []) event.run(row.sequence, row.taskId, row.type, JSON.stringify(row.payload ?? {}), row.createdAt);
      this.audit("backup.imported", `Imported ${snapshot.tasks.length} tasks, ${snapshot.approvals.length} approvals, and ${snapshot.audit.length} audit events.`);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  createInfrastructurePlan(plan) {
    const approval = this.createApproval({ capability: plan.capability, summary: `${plan.action} ${plan.digest}` });
    const createdAt = new Date().toISOString();
    this.#db.prepare("INSERT INTO local_infrastructure_plans (id,action,digest,capability,preview,input,approval_id,status,created_at,expires_at,executed_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)")
      .run(plan.id, plan.action, plan.digest, plan.capability, JSON.stringify(plan.preview), JSON.stringify(plan.input), approval.id, "pending", createdAt, plan.expiresAt);
    this.audit("infrastructure.previewed", `${plan.action} digest=${plan.digest}`);
    return { ...plan, approvalId: approval.id, status: "pending", createdAt };
  }

  infrastructurePlan(id) {
    const row = this.#db.prepare("SELECT id,action,digest,capability,preview,input,approval_id AS approvalId,status,created_at AS createdAt,expires_at AS expiresAt,executed_at AS executedAt FROM local_infrastructure_plans WHERE id = ?").get(id);
    return row ? { ...row, preview: JSON.parse(row.preview), input: JSON.parse(row.input) } : null;
  }

  claimInfrastructurePlan(id) {
    const plan = this.infrastructurePlan(id);
    if (!plan || plan.status !== "pending" || Date.parse(plan.expiresAt) <= Date.now()) return null;
    const approval = this.approval(plan.approvalId);
    if (!approval || approval.status !== "approved" || approval.summary !== `${plan.action} ${plan.digest}`) return null;
    const result = this.#db.prepare("UPDATE local_infrastructure_plans SET status = 'executing' WHERE id = ? AND status = 'pending'").run(id);
    return result.changes ? { ...plan, status: "executing" } : null;
  }

  finishInfrastructurePlan(id, status, receipt) {
    if (!["completed", "failed"].includes(status)) throw new Error("Invalid infrastructure plan status.");
    const safeReceipt = JSON.stringify(receipt ?? {}).replace(/Bearer\s+[^\s"}]+/giu, "Bearer [redacted]").slice(0, 8000);
    this.#db.prepare("UPDATE local_infrastructure_plans SET status = ?, executed_at = ? WHERE id = ? AND status = 'executing'").run(status, new Date().toISOString(), id);
    this.audit(`infrastructure.${status}`, `${id} ${safeReceipt}`);
    return this.infrastructurePlan(id);
  }

  finish(id, status, message) {
    if (!['completed', 'failed'].includes(status)) throw new Error("Task completion status must be completed or failed.");
    this.#db.prepare("UPDATE local_tasks SET status = ?, message = ?, completed_at = ? WHERE id = ?")
      .run(status, message, new Date().toISOString(), id);
    return this.get(id);
  }

  close() { this.#db.close(); }
}
