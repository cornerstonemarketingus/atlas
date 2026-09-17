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
  snapshot() { return { version: 1, exportedAt: new Date().toISOString(), tasks: this.list(10_000), policies: this.policies(), approvals: this.approvals(), audit: this.auditEvents(10_000) }; }
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
      this.audit("backup.imported", `Imported ${snapshot.tasks.length} tasks, ${snapshot.approvals.length} approvals, and ${snapshot.audit.length} audit events.`);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  finish(id, status, message) {
    if (!['completed', 'failed'].includes(status)) throw new Error("Task completion status must be completed or failed.");
    this.#db.prepare("UPDATE local_tasks SET status = ?, message = ?, completed_at = ? WHERE id = ?")
      .run(status, message, new Date().toISOString(), id);
    return this.get(id);
  }

  close() { this.#db.close(); }
}
