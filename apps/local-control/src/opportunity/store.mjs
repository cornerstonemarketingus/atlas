import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * What Atlas knows about every opportunity it has seen, and what it did.
 *
 * One row per canonical address, so the same listing found by two searches,
 * two hunts or two weeks apart is one record. Its status is Atlas's memory:
 * a record the owner skipped, that lost, expired or was rejected as a scam is
 * never surfaced again, and one already being pursued cannot be claimed twice.
 */

/** From → the statuses it may move to. Anything else is refused. */
export const TRANSITIONS = Object.freeze({
  discovered: ["approved", "manual", "pursuing", "skipped", "expired"],
  approved: ["pursuing", "skipped", "expired"],
  manual: ["applied", "won", "lost", "skipped", "expired"],
  pursuing: ["applied", "lost", "skipped"],
  applied: ["won", "lost"],
  won: [], lost: [], skipped: [], expired: [], rejected: [],
});
/** Statuses that mean Atlas is done with the record: re-discovery changes nothing. */
export const SETTLED = new Set(["won", "lost", "skipped", "expired", "rejected"]);

export class OpportunityStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpportunityStoreError";
    this.code = code;
  }
}

export class OpportunityStore {
  #db;

  constructor(filename = ":memory:") {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        score REAL,
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS opportunity_log (
        opportunity_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        PRIMARY KEY (opportunity_id, seq)
      );
      CREATE TABLE IF NOT EXISTS hunts (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close() { this.#db.close(); }

  // ── opportunities ──────────────────────────────────────────────────────────

  byKey(key) {
    const row = this.#db.prepare("SELECT body FROM opportunities WHERE key = ?").get(key);
    return row ? JSON.parse(row.body) : null;
  }

  get(id) {
    const row = this.#db.prepare("SELECT body FROM opportunities WHERE id = ?").get(String(id));
    return row ? JSON.parse(row.body) : null;
  }

  /** Ranked: scored first (best first), then unscored by recency. */
  list({ status = null, huntId = null, executionClass = null, limit = 200 } = {}) {
    const rows = this.#db.prepare("SELECT body FROM opportunities ORDER BY (score IS NULL), score DESC, updated_at DESC").all().map((row) => JSON.parse(row.body));
    return rows
      .filter((row) => (!status || row.status === status) && (!executionClass || row.executionClass === executionClass) && (!huntId || row.huntIds.includes(huntId)))
      .slice(0, limit);
  }

  counts() {
    const counts = {};
    for (const row of this.#db.prepare("SELECT status, COUNT(*) AS n FROM opportunities GROUP BY status").all()) counts[row.status] = Number(row.n);
    return counts;
  }

  /**
   * Record a finding. A key seen before keeps its status and history:
   * the facts are refreshed only while it is still just discovered, and a
   * settled record is left exactly as it is.
   * @returns {{ opportunity: object, created: boolean, refreshed: boolean }}
   */
  upsert(found, { huntId = null, at }) {
    const existing = this.byKey(found.key);
    if (!existing) {
      const opportunity = {
        ...found,
        id: `opp-${randomUUID()}`,
        status: found.status ?? "discovered",
        huntIds: huntId ? [huntId] : [],
        seen: 1, firstSeenAt: at, lastSeenAt: at, updatedAt: at, statusReason: found.statusReason ?? null,
      };
      this.#save(opportunity);
      this.log(opportunity.id, at, "discovered", { source: opportunity.source, class: opportunity.executionClass, score: opportunity.score });
      return { opportunity, created: true, refreshed: false };
    }
    const huntIds = huntId && !existing.huntIds.includes(huntId) ? [...existing.huntIds, huntId] : existing.huntIds;
    if (existing.status !== "discovered") {
      const kept = { ...existing, huntIds, seen: existing.seen + 1, lastSeenAt: at };
      this.#save(kept);
      return { opportunity: kept, created: false, refreshed: false };
    }
    const changed = existing.digest !== found.digest;
    const refreshed = { ...existing, ...found, id: existing.id, status: existing.status, huntIds, seen: existing.seen + 1, firstSeenAt: existing.firstSeenAt, lastSeenAt: at, updatedAt: at, statusReason: existing.statusReason };
    this.#save(refreshed);
    if (changed) this.log(existing.id, at, "refreshed", { digest: found.digest });
    return { opportunity: refreshed, created: false, refreshed: changed };
  }

  /** Move to a new status along an allowed transition; anything else is refused. */
  transition(id, to, { at, reason = null, from = null, extra = {} }) {
    const current = this.get(id);
    if (!current) throw new OpportunityStoreError("UNKNOWN_OPPORTUNITY", "Opportunity not found.");
    if (from && !from.includes(current.status)) throw new OpportunityStoreError("INVALID_TRANSITION", `This opportunity is ${current.status}, so it cannot become ${to}.`);
    if (!TRANSITIONS[current.status]?.includes(to)) throw new OpportunityStoreError("INVALID_TRANSITION", `This opportunity is ${current.status}, so it cannot become ${to}.`);
    const next = { ...current, ...extra, status: to, statusReason: reason, updatedAt: at };
    this.#save(next);
    this.log(id, at, to, { from: current.status, reason });
    return next;
  }

  #save(opportunity) {
    this.#db.prepare("INSERT INTO opportunities (id, key, status, score, body, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, score = excluded.score, body = excluded.body, updated_at = excluded.updated_at")
      .run(opportunity.id, opportunity.key, opportunity.status, opportunity.score ?? null, JSON.stringify(opportunity), opportunity.updatedAt);
  }

  log(opportunityId, at, kind, detail = {}) {
    const next = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM opportunity_log WHERE opportunity_id = ?").get(opportunityId).seq;
    this.#db.prepare("INSERT INTO opportunity_log (opportunity_id, seq, at, kind, detail) VALUES (?, ?, ?, ?, ?)").run(opportunityId, next, at, kind, JSON.stringify(detail).slice(0, 4000));
  }

  history(opportunityId) {
    return this.#db.prepare("SELECT seq, at, kind, detail FROM opportunity_log WHERE opportunity_id = ? ORDER BY seq").all(opportunityId)
      .map((row) => ({ seq: row.seq, at: row.at, kind: row.kind, detail: JSON.parse(row.detail) }));
  }

  // ── hunts ──────────────────────────────────────────────────────────────────

  saveHunt(hunt) {
    this.#db.prepare("INSERT INTO hunts (id, state, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, body = excluded.body, updated_at = excluded.updated_at")
      .run(hunt.id, hunt.state, JSON.stringify(hunt), hunt.updatedAt);
    return hunt;
  }

  hunt(id) {
    const row = this.#db.prepare("SELECT body FROM hunts WHERE id = ?").get(String(id));
    return row ? JSON.parse(row.body) : null;
  }

  hunts(limit = 50) {
    return this.#db.prepare("SELECT body FROM hunts ORDER BY updated_at DESC LIMIT ?").all(limit).map((row) => JSON.parse(row.body));
  }

  /** Hunts left "scouting" by a process that stopped. */
  interruptedHunts() {
    return this.#db.prepare("SELECT body FROM hunts WHERE state = 'scouting'").all().map((row) => JSON.parse(row.body));
  }
}
