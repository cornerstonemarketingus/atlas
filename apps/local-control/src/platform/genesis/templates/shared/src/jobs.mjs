import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Durable, at-least-once local jobs. Handlers must make side effects idempotent. */
export class JobStore {
  #db;
  #now;
  constructor(filename = ":memory:", { now = Date.now } = {}) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.#now = now;
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS atlas_jobs_v1 (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
        dedupe TEXT UNIQUE, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL, available_at INTEGER NOT NULL,
        lease_until INTEGER, lease TEXT, result TEXT);
      CREATE INDEX IF NOT EXISTS atlas_jobs_ready_v1 ON atlas_jobs_v1(state, available_at);`);
  }
  close() { this.#db.close(); }
  get(id) {
    const row = this.#db.prepare("SELECT * FROM atlas_jobs_v1 WHERE id=?").get(id);
    return row ? { id: row.id, kind: row.kind, payload: JSON.parse(row.payload), state: row.state,
      attempts: row.attempts, maxAttempts: row.max_attempts, availableAt: row.available_at,
      result: row.result === null ? null : JSON.parse(row.result) } : null;
  }
  enqueue(kind, payload = {}, { key = null, maxAttempts = 3, delayMs = 0 } = {}) {
    if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{0,79}$/u.test(kind)) throw new Error("Invalid job kind.");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Invalid attempt limit.");
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 86400000) throw new Error("Invalid job delay.");
    if (key !== null && (typeof key !== "string" || !key.length || key.length > 200)) throw new Error("Invalid job key.");
    const encoded = JSON.stringify(payload);
    if (encoded === undefined || Buffer.byteLength(encoded) > 65536) throw new Error("Job payload exceeds 64 KiB.");
    const id = randomUUID();
    this.#db.prepare("INSERT OR IGNORE INTO atlas_jobs_v1(id,kind,payload,dedupe,state,max_attempts,available_at) VALUES(?,?,?,?,'queued',?,?)")
      .run(id, kind, encoded, key, maxAttempts, this.#now() + delayMs);
    const existing = key === null ? null : this.#db.prepare("SELECT id,kind,payload FROM atlas_jobs_v1 WHERE dedupe=?").get(key);
    if (existing && (existing.kind !== kind || existing.payload !== encoded)) throw new Error("Job key already names different work.");
    return this.get(existing?.id ?? id);
  }
  async runNext(handlers, { leaseMs = 60000 } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3600000) throw new Error("Invalid lease duration.");
    const kinds = Object.keys(handlers).filter((kind) => typeof handlers[kind] === "function");
    if (!kinds.length) return null;
    const now = this.#now();
    const lease = randomUUID();
    let row;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE atlas_jobs_v1 SET state='failed',lease=NULL WHERE state='running' AND lease_until<=? AND attempts>=max_attempts").run(now);
      row = this.#db.prepare(`SELECT id FROM atlas_jobs_v1 WHERE kind IN (${kinds.map(() => "?").join(",")})
        AND attempts<max_attempts AND ((state='queued' AND available_at<=?) OR (state='running' AND lease_until<=?)) ORDER BY available_at,id LIMIT 1`).get(...kinds, now, now);
      if (row) this.#db.prepare("UPDATE atlas_jobs_v1 SET state='running',attempts=attempts+1,lease=?,lease_until=? WHERE id=?").run(lease, now + leaseMs, row.id);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    if (!row) return null;
    const job = this.get(row.id);
    try {
      const result = JSON.stringify(await handlers[job.kind](job.payload, { id: job.id, attempt: job.attempts })) ?? "null";
      if (Buffer.byteLength(result) > 65536) throw new Error("Job result exceeds 64 KiB.");
      this.#db.prepare("UPDATE atlas_jobs_v1 SET state='completed',result=?,lease=NULL WHERE id=? AND lease=?").run(result, job.id, lease);
    } catch {
      // Do not persist exception text: handlers may include credentials in it.
      this.#db.prepare("UPDATE atlas_jobs_v1 SET state=?,available_at=?,lease=NULL WHERE id=? AND lease=?")
        .run(job.attempts >= job.maxAttempts ? "failed" : "queued", this.#now() + Math.min(60000, 1000 * 2 ** (job.attempts - 1)), job.id, lease);
    }
    return this.get(job.id);
  }
}
