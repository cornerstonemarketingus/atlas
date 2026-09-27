import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const MAX_MISSION_SNAPSHOT_BYTES = 1_048_576;
const MAX_MISSION_EVENT_BYTES = 262_144;
const MISSION_STATUSES = new Set(["pending", "running", "interrupted", "completed", "failed", "cancelled"]);

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
      CREATE TRIGGER IF NOT EXISTS local_audit_no_update BEFORE UPDATE ON local_audit BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS local_audit_no_delete BEFORE DELETE ON local_audit BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;
      CREATE TABLE IF NOT EXISTS local_missions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_missions_updated_at_idx ON local_missions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS local_mission_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        mission_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (mission_id) REFERENCES local_missions(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS local_mission_events_mission_sequence_idx ON local_mission_events(mission_id, sequence);
      CREATE INDEX IF NOT EXISTS local_mission_events_mission_id_idx ON local_mission_events(mission_id);
      CREATE TRIGGER IF NOT EXISTS local_mission_events_no_update BEFORE UPDATE ON local_mission_events BEGIN SELECT RAISE(ABORT, 'Mission events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS local_mission_events_no_delete BEFORE DELETE ON local_mission_events BEGIN SELECT RAISE(ABORT, 'Mission events are append-only'); END;
      INSERT OR IGNORE INTO local_policies (capability, decision) VALUES ('code.write', 'ask'), ('computer.high_risk', 'ask'), ('publish.remote', 'ask'), ('repository.read', 'allow'), ('desktop.observe', 'ask'), ('desktop.control', 'ask'), ('terminal.run', 'ask'), ('genesis.plan', 'allow');
    `);
    // Additive migrations for approvals bound to an agent action. Older
    // installations have the table without these columns; adding them is
    // safe and keeps existing approvals readable.
    for (const column of ["action_digest TEXT", "session_id TEXT", "consumed_at TEXT"]) {
      try { this.#db.exec(`ALTER TABLE local_approvals ADD COLUMN ${column}`); }
      catch { /* Already present. */ }
    }
    this.#db.exec("CREATE INDEX IF NOT EXISTS local_approvals_digest_idx ON local_approvals(action_digest)");
    this.#db.prepare("UPDATE local_tasks SET status = 'interrupted', message = 'Atlas restarted while this task was running.', completed_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
    this.#interruptRunningMissions();
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

  createApproval({ taskId = null, capability, summary, actionDigest = null, sessionId = null }) {
    // One pending approval per action: a model that asks twice for the same
    // thing must not produce two prompts the operator has to answer.
    if (actionDigest) {
      const existing = this.#db.prepare("SELECT id FROM local_approvals WHERE action_digest = ? AND status = 'pending'").get(actionDigest);
      if (existing) return this.approval(existing.id);
    }
    const row = { id: randomUUID(), taskId, capability, summary, status: "pending", requestedAt: new Date().toISOString(), resolvedAt: null, actionDigest, sessionId };
    this.#db.prepare("INSERT INTO local_approvals (id, task_id, capability, summary, status, requested_at, resolved_at, action_digest, session_id, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(row.id, row.taskId, row.capability, row.summary, row.status, row.requestedAt, row.resolvedAt, actionDigest, sessionId);
    this.audit("approval.requested", `${capability}: ${summary}`);
    return row;
  }
  approvals() { return this.#db.prepare("SELECT id, task_id AS taskId, capability, summary, status, requested_at AS requestedAt, resolved_at AS resolvedAt, action_digest AS actionDigest, session_id AS sessionId FROM local_approvals ORDER BY requested_at DESC").all(); }
  approval(id) { return this.#db.prepare("SELECT id, task_id AS taskId, capability, summary, status, requested_at AS requestedAt, resolved_at AS resolvedAt, action_digest AS actionDigest, session_id AS sessionId FROM local_approvals WHERE id = ?").get(id) ?? null; }

  /**
   * Spends an approval for exactly this action digest, once.
   *
   * The read and the update share a transaction, so two tool calls racing for
   * the same approval cannot both be told yes.
   */
  consumeApprovedDigest(actionDigest) {
    if (!actionDigest) return false;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT id FROM local_approvals WHERE action_digest = ? AND status = 'approved' AND consumed_at IS NULL").get(actionDigest);
      if (!row) { this.#db.exec("COMMIT"); return false; }
      this.#db.prepare("UPDATE local_approvals SET consumed_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
      this.#db.exec("COMMIT");
      this.audit("approval.consumed", `${actionDigest.slice(0, 16)} spent`);
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  decideApproval(id, decision) { if (!['approved','denied'].includes(decision)) throw new Error("Invalid approval decision."); const current = this.approval(id); if (!current || current.status !== 'pending') return null; this.#db.prepare("UPDATE local_approvals SET status = ?, resolved_at = ? WHERE id = ?").run(decision, new Date().toISOString(), id); this.audit("approval.decided", `${id}=${decision}`); return this.approval(id); }

  addPairingCode(codeHash, expiresAt) { this.#db.prepare("INSERT INTO local_pairing_codes VALUES (?, ?, NULL)").run(codeHash, expiresAt); }
  consumePairingCode(codeHash, now) { const row = this.#db.prepare("SELECT code_hash AS codeHash FROM local_pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").get(codeHash, now); if (!row) return false; this.#db.prepare("UPDATE local_pairing_codes SET used_at = ? WHERE code_hash = ?").run(now, codeHash); return true; }
  addDevice(name, tokenHash) { const row = { id: randomUUID(), name, tokenHash, createdAt: new Date().toISOString() }; this.#db.prepare("INSERT INTO local_devices (id,name,token_hash,created_at,revoked_at) VALUES (?,?,?,?,NULL)").run(row.id,row.name,row.tokenHash,row.createdAt); this.audit("device.paired", name); return { id: row.id, name: row.name, createdAt: row.createdAt }; }
  deviceByTokenHash(tokenHash) { return this.#db.prepare("SELECT id,name,created_at AS createdAt FROM local_devices WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash) ?? null; }
  devices() { return this.#db.prepare("SELECT id,name,created_at AS createdAt,revoked_at AS revokedAt FROM local_devices ORDER BY created_at DESC").all(); }
  revokeDevice(id) { const result = this.#db.prepare("UPDATE local_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id); if (!result.changes) return null; this.audit("device.revoked", id); return this.devices().find((device) => device.id === id); }

  audit(category, summary) { this.#db.prepare("INSERT INTO local_audit VALUES (?, ?, ?, ?)").run(randomUUID(), category, String(summary).slice(0, 2000), new Date().toISOString()); }
  auditEvents(limit = 200) { return this.#db.prepare("SELECT id,category,summary,created_at AS createdAt FROM local_audit ORDER BY created_at DESC LIMIT ?").all(limit); }
  saveMission(snapshot) {
    const id = snapshot?.plan?.id ?? snapshot?.id;
    const status = snapshot?.status;
    return this.saveMissionSnapshot({ id, status, snapshot });
  }

  saveMissionSnapshot({ id, status, snapshot }) {
    validateMissionId(id);
    if (!MISSION_STATUSES.has(status)) throw new Error("Invalid mission status.");
    const snapshotJson = boundedJson(snapshot, MAX_MISSION_SNAPSHOT_BYTES, "Mission snapshot");
    const now = new Date().toISOString();
    this.#db.prepare(`INSERT INTO local_missions (id, status, snapshot_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`)
      .run(id, status, snapshotJson, now, now);
    return this.missionSnapshot(id);
  }

  missionSnapshot(id) {
    validateMissionId(id);
    const row = this.#db.prepare("SELECT id, status, snapshot_json AS snapshotJson, created_at AS createdAt, updated_at AS updatedAt FROM local_missions WHERE id = ?").get(id);
    return row ? decodeMission(row) : null;
  }

  mission(id) { return this.missionSnapshot(id); }

  missionSnapshots(limit = 50) {
    const boundedLimit = normalizeLimit(limit, 500);
    return this.#db.prepare("SELECT id, status, snapshot_json AS snapshotJson, created_at AS createdAt, updated_at AS updatedAt FROM local_missions ORDER BY updated_at DESC, id LIMIT ?")
      .all(boundedLimit).map(decodeMission);
  }

  missions(limit = 50) { return this.#allMissionSnapshots(normalizeLimit(limit, 10_000)); }

  appendMissionEvent(missionIdOrEvent, event = undefined) {
    const missionId = event === undefined ? missionIdOrEvent?.missionId : missionIdOrEvent;
    const type = event === undefined ? missionIdOrEvent?.type : event?.type;
    const payload = event === undefined ? missionIdOrEvent?.payload : event?.payload;
    validateMissionId(missionId);
    if (typeof type !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(type)) throw new Error("Invalid mission event type.");
    const payloadJson = boundedJson(payload, MAX_MISSION_EVENT_BYTES, "Mission event payload");
    const row = { id: randomUUID(), missionId, type, createdAt: new Date().toISOString() };
    const result = this.#db.prepare("INSERT INTO local_mission_events (id, mission_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.missionId, row.type, payloadJson, row.createdAt);
    return { sequence: Number(result.lastInsertRowid), ...row, payload: JSON.parse(payloadJson) };
  }

  missionEvents(missionId, { after = 0, afterSequence = after, limit = 200 } = {}) {
    validateMissionId(missionId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative integer.");
    const boundedLimit = normalizeLimit(limit, 1000);
    return this.#db.prepare(`SELECT sequence, id, mission_id AS missionId, type, payload_json AS payloadJson, created_at AS createdAt
      FROM local_mission_events WHERE mission_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
      .all(missionId, afterSequence, boundedLimit).map(decodeMissionEvent);
  }

  snapshot() { return { version: 2, exportedAt: new Date().toISOString(), tasks: this.list(10_000), policies: this.policies(), approvals: this.approvals(), audit: this.auditEvents(10_000), missions: this.#allMissionSnapshots(10_000), missionEvents: this.#allMissionEvents(50_000) }; }
  importSnapshot(snapshot) {
    if (!snapshot || ![1, 2].includes(snapshot.version) || !["tasks", "policies", "approvals", "audit"].every((key) => Array.isArray(snapshot[key]))) throw new Error("Invalid Atlas backup data.");
    if (snapshot.version === 2 && !["missions", "missionEvents"].every((key) => Array.isArray(snapshot[key]))) throw new Error("Invalid Atlas backup data.");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#db.prepare("INSERT OR IGNORE INTO local_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const row of snapshot.tasks) { const status = row.status === "running" ? "interrupted" : row.status; task.run(row.id, row.repository, row.objective, row.model, status, status === "interrupted" ? "Imported task was running when exported." : row.message ?? null, row.createdAt, row.startedAt ?? null, row.completedAt ?? null); }
      const policy = this.#db.prepare("INSERT INTO local_policies (capability,decision) VALUES (?,?) ON CONFLICT(capability) DO UPDATE SET decision=excluded.decision");
      for (const row of snapshot.policies) { if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(row.capability) || !["allow", "ask", "deny"].includes(row.decision)) throw new Error("Invalid policy in backup."); policy.run(row.capability, row.decision); }
      // Columns are named rather than positional: the table gained
      // action_digest, session_id and consumed_at, and a positional insert
      // would have silently started failing on every restore.
      const approval = this.#db.prepare("INSERT OR IGNORE INTO local_approvals (id, task_id, capability, summary, status, requested_at, resolved_at, action_digest, session_id, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      // A restored approval is history, never authority: a backup file is
      // just data, so an "approved" row in it must not be spendable here.
      // Pending ones are expired and approved ones are marked consumed.
      const restoredAt = new Date().toISOString();
      for (const row of snapshot.approvals) {
        const status = row.status === "pending" ? "expired" : row.status;
        approval.run(row.id, row.taskId ?? null, row.capability, row.summary, status, row.requestedAt, row.resolvedAt ?? restoredAt, row.actionDigest ?? null, row.sessionId ?? null, row.consumedAt ?? restoredAt);
      }
      // Imported audit entries are labelled as imported so they can never be
      // mistaken for something that happened on this machine.
      const audit = this.#db.prepare("INSERT OR IGNORE INTO local_audit VALUES (?, ?, ?, ?)");
      for (const row of snapshot.audit) audit.run(`imported:${row.id}`, `imported:${String(row.category).slice(0, 64)}`, String(row.summary).slice(0, 2000), row.createdAt);
      const mission = this.#db.prepare("INSERT OR IGNORE INTO local_missions (id, status, snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
      for (const row of snapshot.missions ?? []) {
        validateMissionId(row.id);
        const restored = interruptMission(row.status, row.snapshot);
        mission.run(row.id, restored.status, boundedJson(restored.snapshot, MAX_MISSION_SNAPSHOT_BYTES, "Mission snapshot"), row.createdAt, row.updatedAt);
      }
      // Let SQLite allocate a fresh global sequence. Imported sequence values
      // can collide with unrelated local events; preserving them would make
      // INSERT OR IGNORE silently drop otherwise unique audit evidence.
      const missionEvent = this.#db.prepare("INSERT OR IGNORE INTO local_mission_events (id, mission_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const row of [...(snapshot.missionEvents ?? [])].sort((left, right) => left.sequence - right.sequence)) {
        validateMissionId(row.missionId);
        if (typeof row.type !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(row.type)) throw new Error("Invalid mission event type in backup.");
        missionEvent.run(row.id, row.missionId, row.type, boundedJson(row.payload, MAX_MISSION_EVENT_BYTES, "Mission event payload"), row.createdAt);
      }
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

  #allMissionEvents(limit) {
    return this.#db.prepare(`SELECT sequence, id, mission_id AS missionId, type, payload_json AS payloadJson, created_at AS createdAt
      FROM local_mission_events ORDER BY sequence LIMIT ?`).all(limit).map(decodeMissionEvent);
  }

  #allMissionSnapshots(limit) {
    return this.#db.prepare("SELECT id, status, snapshot_json AS snapshotJson, created_at AS createdAt, updated_at AS updatedAt FROM local_missions ORDER BY updated_at DESC, id LIMIT ?")
      .all(limit).map(decodeMission);
  }

  #interruptRunningMissions() {
    const running = this.#db.prepare("SELECT id, snapshot_json AS snapshotJson FROM local_missions WHERE status = 'running'").all();
    if (!running.length) return;
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.#db.prepare("UPDATE local_missions SET status = 'interrupted', snapshot_json = ?, updated_at = ? WHERE id = ? AND status = 'running'");
      const event = this.#db.prepare("INSERT INTO local_mission_events (id, mission_id, type, payload_json, created_at) VALUES (?, ?, 'mission.interrupted', ?, ?)");
      for (const row of running) {
        const restored = interruptMission("running", JSON.parse(row.snapshotJson));
        update.run(boundedJson(restored.snapshot, MAX_MISSION_SNAPSHOT_BYTES, "Mission snapshot"), now, row.id);
        event.run(randomUUID(), row.id, JSON.stringify({ reason: "process_restart" }), now);
      }
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
}

function validateMissionId(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) throw new Error("Invalid mission id.");
}

function normalizeLimit(limit, maximum) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer.");
  return Math.min(limit, maximum);
}

function boundedJson(value, maximumBytes, label) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch (error) { throw new Error(`${label} must be JSON serializable: ${error.message}`); }
  if (encoded === undefined) throw new Error(`${label} must be JSON serializable.`);
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
  return encoded;
}

function decodeMission(row) {
  const { snapshotJson, ...metadata } = row;
  return { ...metadata, snapshot: JSON.parse(snapshotJson) };
}

function decodeMissionEvent(row) {
  const { payloadJson, ...metadata } = row;
  return { ...metadata, payload: JSON.parse(payloadJson) };
}

function interruptMission(status, snapshot) {
  if (status !== "running") return { status, snapshot };
  const copy = JSON.parse(boundedJson(snapshot, MAX_MISSION_SNAPSHOT_BYTES, "Mission snapshot"));
  copy.status = "interrupted";
  copy.reason ??= "Atlas restarted while child agents were running.";
  if (Array.isArray(copy.children)) {
    for (const child of copy.children) {
      if (child?.state === "running") {
        child.state = "interrupted";
        child.error = { code: "INTERRUPTED", message: "Atlas restarted while this child was running." };
      }
    }
  }
  return { status: "interrupted", snapshot: copy };
}
