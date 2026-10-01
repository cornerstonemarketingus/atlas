import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ID = /^self-[0-9]{14}-[a-z0-9]{1,8}$/u;
export class RecoveryError extends Error {
  constructor(message) { super(message); this.code = "RECOVERY_CONFLICT"; }
}

/** Durable checkpoints/leases for the existing loop, not another task scheduler. */
export class ReviewRecovery {
  constructor(directory) { this.directory = directory; }
  #id(id) { if (!ID.test(id)) throw new RecoveryError("Invalid recovery identifier."); return id; }
  #use(fn) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, "review-recovery.sqlite");
    const db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL)");
      return fn(db);
    } finally { db.close(); }
  }
  read(id) {
    const row = this.#use(db => db.prepare("SELECT value FROM checkpoints WHERE id=?").get(this.#id(id)));
    if (!row) throw new RecoveryError("This candidate is no longer available for recovery.");
    return JSON.parse(row.value);
  }
  list() { return this.#use(db => db.prepare("SELECT value FROM checkpoints ORDER BY id").all().map(row => JSON.parse(row.value))); }
  write(value) {
    const text = JSON.stringify(value);
    if (text.length > 100_000) throw new RecoveryError("Recovery checkpoint is too large.");
    this.#use(db => db.prepare("INSERT INTO checkpoints VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(this.#id(value.id), text));
  }
  remove(id) { this.#use(db => db.prepare("DELETE FROM checkpoints WHERE id=?").run(this.#id(id))); }
  /** Atomic cross-process exclusion; only a dead process lease can be reclaimed. */
  lock(id) {
    this.#id(id);
    const token = randomUUID();
    this.#use(db => {
      db.exec("BEGIN IMMEDIATE");
      const lease = db.prepare("SELECT pid FROM leases WHERE id=?").get(id);
      if (lease) {
        let alive = true;
        try { process.kill(lease.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
        if (alive) throw new RecoveryError("Another run owns this candidate.");
      }
      db.prepare("INSERT INTO leases VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token").run(id, process.pid, token);
      db.exec("COMMIT");
    });
    return () => this.#use(db => db.prepare("DELETE FROM leases WHERE id=? AND token=?").run(id, token));
  }
}
