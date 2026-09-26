import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { newId } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { DesktopError } from "./errors.mjs";

/**
 * Durable state for desktop control, independent of any adapter:
 *
 *   - device enrollment: enroll -> pending -> owner approves -> enrolled;
 *     an owner can reject a pending device or revoke an enrolled one.
 *   - control-session approvals: an agent (or a person) asks for a scoped,
 *     short-lived session on an enrolled device; only the device's owner can
 *     approve it; the approval is single-use and expires.
 *   - sessions, the audit trail, screenshots stored by digest, and the
 *     emergency-stop latch.
 *
 * The emergency-stop latch lives here, not in memory, so a restarted daemon
 * comes back stopped if it was stopped: re-arming is always an explicit act.
 */
const DEVICE_STATES = ["pending", "enrolled", "rejected", "revoked"];
const APPROVAL_STATES = ["pending", "approved", "rejected", "consumed", "expired"];
const SESSION_STATES = ["active", "paused", "ended", "expired", "revoked", "emergency_stopped"];

export const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
export const MAX_SESSION_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${DEVICE_STATES.map((s) => `'${s}'`).join(",")})),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT
);
CREATE TABLE IF NOT EXISTS desktop_session_approvals (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES desktop_devices(id),
  requested_by TEXT NOT NULL,
  purpose TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  session_ttl_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${APPROVAL_STATES.map((s) => `'${s}'`).join(",")})),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  consumed_by_session TEXT
);
CREATE TABLE IF NOT EXISTS desktop_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES desktop_devices(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES desktop_session_approvals(id),
  requested_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${SESSION_STATES.map((s) => `'${s}'`).join(",")})),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE TABLE IF NOT EXISTS desktop_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  session_id TEXT,
  device_id TEXT,
  actor TEXT,
  action TEXT NOT NULL,
  params_json TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  message TEXT,
  screenshot_digest TEXT,
  coordinate_fallback INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS desktop_audit_session ON desktop_audit(session_id, seq);
CREATE TABLE IF NOT EXISTS desktop_screenshots (
  digest TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_control_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`;

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function cleanList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item || item.length > 200)) {
    throw new DesktopError("INVALID_SCOPE", `${label} must be a list of non-empty strings.`);
  }
  return [...new Set(value)];
}

/**
 * A session scope names the apps (by process / app name) and/or window-title
 * fragments it may act in. At least one of the two is required: a session
 * scoped to nothing would be a session scoped to everything.
 */
export function normalizeScope(scope) {
  if (!scope || typeof scope !== "object") throw new DesktopError("INVALID_SCOPE", "A session scope is required.");
  const allowedApps = cleanList(scope.allowedApps, "allowedApps");
  const allowedWindows = cleanList(scope.allowedWindows, "allowedWindows");
  if (allowedApps.length === 0 && allowedWindows.length === 0) {
    throw new DesktopError("INVALID_SCOPE", "A session must be scoped to at least one app or window.");
  }
  return { allowedApps, allowedWindows };
}

export function newDeviceId() {
  return `dev_${randomBytes(16).toString("hex")}`;
}

export class DesktopSafetyStore {
  #db;
  #clock;

  constructor({ path = ":memory:", clock = () => new Date() } = {}) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
    this.#clock = clock;
  }

  now() { return this.#clock(); }
  close() { this.#db.close(); }

  transaction(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Device enrollment
  // -------------------------------------------------------------------------

  enrollDevice({ ownerId, name, platform = "unknown" }) {
    if (typeof ownerId !== "string" || !ownerId) throw new DesktopError("INVALID_REQUEST", "A device needs an owner.");
    if (typeof name !== "string" || !name.trim()) throw new DesktopError("INVALID_REQUEST", "A device needs a name.");
    const id = newDeviceId();
    this.#db.prepare("INSERT INTO desktop_devices (id, owner_id, name, platform, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(id, ownerId, name.trim().slice(0, 80), String(platform).slice(0, 32), this.now().toISOString());
    return this.getDevice(id);
  }

  getDevice(id) {
    const row = this.#db.prepare("SELECT * FROM desktop_devices WHERE id = ?").get(id);
    return row ? deviceFromRow(row) : null;
  }

  listDevices(ownerId) {
    return this.#db.prepare("SELECT * FROM desktop_devices WHERE owner_id = ? ORDER BY created_at, id").all(ownerId).map(deviceFromRow);
  }

  /** Only the device's owner decides; a pending device is the only one that can be decided. */
  decideDevice(id, { ownerId, approve }) {
    const device = this.getDevice(id);
    if (!device) throw new DesktopError("NO_DEVICE", "No such device.");
    if (device.ownerId !== ownerId) throw new DesktopError("NOT_OWNER", "Only the device's owner can approve its enrollment.");
    if (device.status !== "pending") throw new DesktopError("INVALID_STATE", `The device is '${device.status}', not pending.`);
    this.#db.prepare("UPDATE desktop_devices SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
      .run(approve ? "enrolled" : "rejected", this.now().toISOString(), ownerId, id);
    return this.getDevice(id);
  }

  approveDevice(id, { ownerId }) { return this.decideDevice(id, { ownerId, approve: true }); }
  rejectDevice(id, { ownerId }) { return this.decideDevice(id, { ownerId, approve: false }); }

  /** Revocation also ends every live session on the device and voids its unused approvals. */
  revokeDevice(id, { by, reason = "revoked by owner" }) {
    const device = this.getDevice(id);
    if (!device) throw new DesktopError("NO_DEVICE", "No such device.");
    if (device.ownerId !== by) throw new DesktopError("NOT_OWNER", "Only the device's owner can revoke it.");
    const at = this.now().toISOString();
    this.transaction(() => {
      this.#db.prepare("UPDATE desktop_devices SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?")
        .run(at, by, String(reason).slice(0, 500), id);
      this.#db.prepare("UPDATE desktop_sessions SET status = 'revoked', ended_at = ?, end_reason = 'device revoked' WHERE device_id = ? AND status IN ('active','paused')")
        .run(at, id);
      this.#db.prepare("UPDATE desktop_session_approvals SET status = 'expired' WHERE device_id = ? AND status IN ('pending','approved')").run(id);
    });
    return this.getDevice(id);
  }

  // -------------------------------------------------------------------------
  // Control-session approvals
  // -------------------------------------------------------------------------

  requestSessionApproval({ deviceId, requestedBy, purpose, scope, sessionTtlMs = DEFAULT_SESSION_TTL_MS, approvalTtlMs = DEFAULT_APPROVAL_TTL_MS }) {
    const device = this.getDevice(deviceId);
    if (!device) throw new DesktopError("NO_DEVICE", "No such device.");
    if (device.status !== "enrolled") throw new DesktopError(device.status === "revoked" ? "DEVICE_REVOKED" : "DEVICE_NOT_ENROLLED", `The device is '${device.status}'.`);
    if (typeof requestedBy !== "string" || !requestedBy) throw new DesktopError("INVALID_REQUEST", "A session request needs a requester.");
    if (typeof purpose !== "string" || !purpose.trim()) throw new DesktopError("INVALID_REQUEST", "A session request must say what it is for.");
    if (!Number.isInteger(sessionTtlMs) || sessionTtlMs <= 0 || sessionTtlMs > MAX_SESSION_TTL_MS) {
      throw new DesktopError("INVALID_REQUEST", `sessionTtlMs must be between 1 and ${MAX_SESSION_TTL_MS}.`);
    }
    const normalized = normalizeScope(scope);
    const id = newId("approval");
    const now = this.now();
    this.#db.prepare(`INSERT INTO desktop_session_approvals
      (id, device_id, requested_by, purpose, scope_json, session_ttl_ms, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, deviceId, requestedBy, purpose.trim().slice(0, 500), JSON.stringify(normalized), sessionTtlMs,
        now.toISOString(), new Date(now.getTime() + approvalTtlMs).toISOString());
    return this.getSessionApproval(id);
  }

  getSessionApproval(id) {
    const row = this.#db.prepare("SELECT * FROM desktop_session_approvals WHERE id = ?").get(id);
    return row ? approvalFromRow(row) : null;
  }

  decideSessionApproval(id, { decidedBy, approve }) {
    const approval = this.getSessionApproval(id);
    if (!approval) throw new DesktopError("NO_APPROVAL", "No such session approval.");
    const device = this.getDevice(approval.deviceId);
    if (device.ownerId !== decidedBy) throw new DesktopError("NOT_OWNER", "Only the device's owner can approve a control session.");
    if (approval.status !== "pending") throw new DesktopError("INVALID_STATE", `The approval is '${approval.status}', not pending.`);
    if (approval.expiresAt <= this.now().toISOString()) {
      this.#db.prepare("UPDATE desktop_session_approvals SET status = 'expired' WHERE id = ?").run(id);
      throw new DesktopError("APPROVAL_EXPIRED", "The approval request expired before it was decided.");
    }
    this.#db.prepare("UPDATE desktop_session_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(approve ? "approved" : "rejected", decidedBy, this.now().toISOString(), id);
    return this.getSessionApproval(id);
  }

  approveSession(id, { decidedBy }) { return this.decideSessionApproval(id, { decidedBy, approve: true }); }
  rejectSession(id, { decidedBy }) { return this.decideSessionApproval(id, { decidedBy, approve: false }); }

  /**
   * Atomically checks and consumes an approval, creating the session it
   * authorizes. Every check that can refuse runs inside the transaction so
   * two racing callers cannot both spend one approval.
   */
  openSession({ approvalId, deviceId, requestedBy, maxSessionTtlMs = MAX_SESSION_TTL_MS }) {
    return this.transaction(() => {
      const approval = this.getSessionApproval(approvalId);
      if (!approval) throw new DesktopError("NO_APPROVAL", "Every control session needs an approval id the device owner approved.");
      if (approval.deviceId !== deviceId) throw new DesktopError("APPROVAL_MISMATCH", "The approval is for a different device.");
      if (requestedBy !== undefined && approval.requestedBy !== requestedBy) throw new DesktopError("APPROVAL_MISMATCH", "The approval was requested by someone else.");
      const device = this.getDevice(deviceId);
      if (!device || device.status !== "enrolled") {
        throw new DesktopError(device?.status === "revoked" ? "DEVICE_REVOKED" : "DEVICE_NOT_ENROLLED", `The device is '${device?.status ?? "unknown"}'.`);
      }
      if (approval.status === "consumed") throw new DesktopError("APPROVAL_USED", "The approval has already opened a session.");
      if (approval.status !== "approved") throw new DesktopError("APPROVAL_REQUIRED", `The approval is '${approval.status}', not approved.`);
      const now = this.now();
      if (approval.expiresAt <= now.toISOString()) {
        this.#db.prepare("UPDATE desktop_session_approvals SET status = 'expired' WHERE id = ?").run(approvalId);
        throw new DesktopError("APPROVAL_EXPIRED", "The approval expired before a session was opened.");
      }
      const id = newId("workerSession");
      const ttl = Math.min(approval.sessionTtlMs, maxSessionTtlMs);
      this.#db.prepare(`INSERT INTO desktop_sessions
        (id, device_id, approval_id, requested_by, approved_by, scope_json, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .run(id, deviceId, approvalId, approval.requestedBy, approval.decidedBy, JSON.stringify(approval.scope),
          now.toISOString(), new Date(now.getTime() + ttl).toISOString());
      this.#db.prepare("UPDATE desktop_session_approvals SET status = 'consumed', consumed_by_session = ? WHERE id = ?").run(id, approvalId);
      return this.getSession(id);
    });
  }

  getSession(id) {
    const row = this.#db.prepare("SELECT * FROM desktop_sessions WHERE id = ?").get(id);
    return row ? sessionFromRow(row) : null;
  }

  listSessions({ deviceId, live = false } = {}) {
    const rows = this.#db.prepare(`SELECT * FROM desktop_sessions WHERE (? IS NULL OR device_id = ?)
      ${live ? "AND status IN ('active','paused')" : ""} ORDER BY created_at, id`).all(deviceId ?? null, deviceId ?? null);
    return rows.map(sessionFromRow);
  }

  setSessionStatus(id, status, { reason = null, ended = false } = {}) {
    if (!SESSION_STATES.includes(status)) throw new DesktopError("INVALID_STATE", `Unknown session status '${status}'.`);
    this.#db.prepare("UPDATE desktop_sessions SET status = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END, end_reason = COALESCE(?, end_reason) WHERE id = ?")
      .run(status, ended ? 1 : 0, this.now().toISOString(), reason, id);
    return this.getSession(id);
  }

  // -------------------------------------------------------------------------
  // Emergency stop latch
  // -------------------------------------------------------------------------

  emergencyState() {
    const row = this.#db.prepare("SELECT value_json FROM desktop_control_state WHERE key = 'emergency_stop'").get();
    return row ? parseJson(row.value_json, { stopped: true }) : { stopped: false };
  }

  setEmergencyState(state) {
    this.#db.prepare("INSERT INTO desktop_control_state (key, value_json) VALUES ('emergency_stop', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(JSON.stringify(state));
    return state;
  }

  // -------------------------------------------------------------------------
  // Audit and screenshots
  // -------------------------------------------------------------------------

  appendAudit({ sessionId = null, deviceId = null, actor = null, action, params = {}, outcome, errorCode = null, message = null, screenshotDigest = null, coordinateFallback = false }) {
    const result = this.#db.prepare(`INSERT INTO desktop_audit
      (at, session_id, device_id, actor, action, params_json, outcome, error_code, message, screenshot_digest, coordinate_fallback)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.now().toISOString(), sessionId, deviceId, actor, action, JSON.stringify(params ?? {}), outcome, errorCode,
        message === null ? null : String(message).slice(0, 500), screenshotDigest, coordinateFallback ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  listAudit({ sessionId = undefined, deviceId = undefined } = {}) {
    const rows = this.#db.prepare(`SELECT * FROM desktop_audit WHERE (? IS NULL OR session_id = ?) AND (? IS NULL OR device_id = ?) ORDER BY seq`)
      .all(sessionId ?? null, sessionId ?? null, deviceId ?? null, deviceId ?? null);
    return rows.map((row) => ({
      seq: row.seq,
      at: row.at,
      sessionId: row.session_id,
      deviceId: row.device_id,
      actor: row.actor,
      action: row.action,
      params: parseJson(row.params_json, {}),
      outcome: row.outcome,
      errorCode: row.error_code,
      message: row.message,
      screenshotDigest: row.screenshot_digest,
      coordinateFallback: row.coordinate_fallback === 1,
    }));
  }

  /** Content-addressed: the audit row holds the digest, the bytes live here once. */
  putScreenshot({ bytes, mediaType, width = null, height = null }) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const digest = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
    this.#db.prepare("INSERT OR IGNORE INTO desktop_screenshots (digest, media_type, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(digest, String(mediaType), width, height, buffer, this.now().toISOString());
    return digest;
  }

  getScreenshot(digest) {
    const row = this.#db.prepare("SELECT * FROM desktop_screenshots WHERE digest = ?").get(digest);
    return row ? { digest: row.digest, mediaType: row.media_type, width: row.width, height: row.height, bytes: Buffer.from(row.bytes) } : null;
  }
}

function deviceFromRow(row) {
  return {
    id: row.id, ownerId: row.owner_id, name: row.name, platform: row.platform, status: row.status, createdAt: row.created_at,
    decidedAt: row.decided_at, decidedBy: row.decided_by, revokedAt: row.revoked_at, revokedBy: row.revoked_by, revokeReason: row.revoke_reason,
  };
}

function approvalFromRow(row) {
  return {
    id: row.id, deviceId: row.device_id, requestedBy: row.requested_by, purpose: row.purpose, scope: parseJson(row.scope_json, {}),
    sessionTtlMs: row.session_ttl_ms, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
    decidedBy: row.decided_by, decidedAt: row.decided_at, consumedBySession: row.consumed_by_session,
  };
}

function sessionFromRow(row) {
  return {
    id: row.id, deviceId: row.device_id, approvalId: row.approval_id, requestedBy: row.requested_by, approvedBy: row.approved_by,
    scope: parseJson(row.scope_json, {}), status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
    endedAt: row.ended_at, endReason: row.end_reason,
  };
}
