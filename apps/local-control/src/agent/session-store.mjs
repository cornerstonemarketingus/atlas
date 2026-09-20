import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { normalizeAgentEvent } from "./events.mjs";
import { DEFAULT_BUDGET, normalizeBudget } from "./budget.mjs";

/**
 * Durable home for conversational sessions, their turns, and their
 * append-only event log.
 *
 * The event log is the product, not a debug aid: reconnecting clients replay
 * from a sequence number, restart recovery reads the tail, and the audit
 * timeline is a projection of it. Events are therefore never updated or
 * deleted — `(session_id, sequence)` is the primary key and the only writer
 * is `appendEvent`, which allocates the next sequence inside a transaction.
 */
export class AgentSessionStore {
  #db;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repository TEXT,
        model TEXT NOT NULL,
        executor TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_sessions_updated_idx ON agent_sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS agent_events (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS agent_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
    `);
    // After the tables, because on a database written before the ordering
    // column existed the index cannot be built until the column is.
    this.#addTurnSequence();
  }

  /**
   * Adds the ordering column to a database written before it existed.
   *
   * Turns were ordered by `created_at` and, on a tie, by `id` -- which is a
   * random UUID. `created_at` has millisecond resolution, so two turns sent
   * back to back tie routinely, and roughly a quarter of such pairs were then
   * answered in the wrong order: "deploy the staging build" answered after
   * "actually, wait". Existing rows are numbered by insertion order, which is
   * what rowid records.
   */
  #addTurnSequence() {
    const columns = this.#db.prepare("PRAGMA table_info(agent_turns)").all();
    if (!columns.some((column) => column.name === "sequence")) {
      this.#db.exec("ALTER TABLE agent_turns ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0");
      this.#db.exec(`
        UPDATE agent_turns SET sequence = (
          SELECT COUNT(*) FROM agent_turns AS earlier
           WHERE earlier.session_id = agent_turns.session_id AND earlier.rowid <= agent_turns.rowid
        );
      `);
      // The old index covered (session_id, created_at) under the same name,
      // so it is replaced rather than left indexing a column nothing reads.
      this.#db.exec("DROP INDEX IF EXISTS agent_turns_session_idx");
    }
    this.#db.exec("CREATE INDEX IF NOT EXISTS agent_turns_session_idx ON agent_turns(session_id, sequence)");
  }

  createSession({ title, repository = null, model, executor = "local", budget = {}, status = "idle" }) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO agent_sessions
           (id, title, repository, model, executor, status, summary, budget_json, usage_json,
            lease_owner, lease_expires_at, last_sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, '{}', NULL, NULL, 0, ?, ?)`,
      )
      .run(id, title, repository, model, executor, status, JSON.stringify(normalizeBudget(budget)), now, now);
    return this.session(id);
  }

  session(id) {
    const row = this.#db
      .prepare(
        `SELECT id, title, repository, model, executor, status, summary,
                budget_json AS budgetJson, usage_json AS usageJson,
                lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
                last_sequence AS lastSequence, created_at AS createdAt, updated_at AS updatedAt
           FROM agent_sessions WHERE id = ?`,
      )
      .get(id);
    return row ? hydrate(row) : null;
  }

  sessions(limit = 50) {
    return this.#db
      .prepare(
        `SELECT id, title, repository, model, executor, status, summary,
                budget_json AS budgetJson, usage_json AS usageJson,
                lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
                last_sequence AS lastSequence, created_at AS createdAt, updated_at AS updatedAt
           FROM agent_sessions ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit)
      .map(hydrate);
  }

  setStatus(id, status, summary = undefined) {
    const now = new Date().toISOString();
    if (summary === undefined) {
      this.#db.prepare("UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    } else {
      this.#db
        .prepare("UPDATE agent_sessions SET status = ?, summary = ?, updated_at = ? WHERE id = ?")
        .run(status, summary, now, id);
    }
    return this.session(id);
  }

  recordUsage(id, usage) {
    this.#db
      .prepare("UPDATE agent_sessions SET usage_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(usage), new Date().toISOString(), id);
  }

  /**
   * Appends one event and returns it with its allocated sequence. The read of
   * `last_sequence` and the insert share a transaction so two concurrent
   * emitters cannot be handed the same number.
   */
  appendEvent(sessionId, event) {
    const normalized = normalizeAgentEvent(event);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT last_sequence AS lastSequence FROM agent_sessions WHERE id = ?").get(sessionId);
      if (!row) throw new Error(`Unknown session: ${sessionId}.`);
      const sequence = row.lastSequence + 1;
      this.#db
        .prepare("INSERT INTO agent_events (session_id, sequence, kind, occurred_at, data_json) VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, sequence, normalized.kind, normalized.occurredAt, JSON.stringify(normalized.data));
      this.#db
        .prepare("UPDATE agent_sessions SET last_sequence = ?, updated_at = ? WHERE id = ?")
        .run(sequence, normalized.occurredAt, sessionId);
      this.#db.exec("COMMIT");
      return { ...normalized, sessionId, sequence };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Events strictly after `afterSequence`, which is how a client resumes. */
  events(sessionId, afterSequence = 0, limit = 500) {
    return this.#db
      .prepare(
        `SELECT sequence, kind, occurred_at AS occurredAt, data_json AS dataJson
           FROM agent_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
      )
      .all(sessionId, afterSequence, limit)
      .map((row) => ({
        sessionId,
        sequence: row.sequence,
        kind: row.kind,
        occurredAt: row.occurredAt,
        data: JSON.parse(row.dataJson),
      }));
  }

  addTurn({ sessionId, role, text, attachments = [] }) {
    const turn = {
      id: randomUUID(),
      sessionId,
      role,
      text,
      attachments,
      state: "pending",
      createdAt: new Date().toISOString(),
    };
    // Allocated from the session's own turns rather than from a clock, so
    // two turns sent in the same millisecond still have an order.
    this.#db
      .prepare(
        `INSERT INTO agent_turns (id, session_id, role, text, attachments_json, state, sequence, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_turns WHERE session_id = ?), ?, NULL, NULL)`,
      )
      .run(turn.id, sessionId, role, text, JSON.stringify(attachments), turn.state, sessionId, turn.createdAt);
    turn.sequence = this.#db.prepare("SELECT sequence FROM agent_turns WHERE id = ?").get(turn.id).sequence;
    this.#db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(turn.createdAt, sessionId);
    return turn;
  }

  turns(sessionId, limit = 500) {
    return this.#db
      .prepare(
        `SELECT id, session_id AS sessionId, role, text, attachments_json AS attachmentsJson, state, sequence,
                created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt
           FROM agent_turns WHERE session_id = ? ORDER BY sequence LIMIT ?`,
      )
      .all(sessionId, limit)
      .map((row) => ({ ...row, attachments: JSON.parse(row.attachmentsJson), attachmentsJson: undefined }));
  }

  /** The oldest turn still waiting to be answered, or null when the queue is drained. */
  nextPendingTurn(sessionId) {
    const row = this.#db
      .prepare(
        `SELECT id, session_id AS sessionId, role, text, attachments_json AS attachmentsJson, state, sequence, created_at AS createdAt
           FROM agent_turns WHERE session_id = ? AND state = 'pending' AND role = 'user'
           ORDER BY sequence LIMIT 1`,
      )
      .get(sessionId);
    return row ? { ...row, attachments: JSON.parse(row.attachmentsJson), attachmentsJson: undefined } : null;
  }

  setTurnState(id, state) {
    const now = new Date().toISOString();
    const column = state === "running" ? "started_at" : "completed_at";
    this.#db.prepare(`UPDATE agent_turns SET state = ?, ${column} = ? WHERE id = ?`).run(state, now, id);
  }

  turn(id) {
    const row = this.#db
      .prepare(
        `SELECT id, session_id AS sessionId, role, text, attachments_json AS attachmentsJson, state, sequence, created_at AS createdAt
           FROM agent_turns WHERE id = ?`,
      )
      .get(id);
    return row ? { ...row, attachments: JSON.parse(row.attachmentsJson), attachmentsJson: undefined } : null;
  }

  /** Rewrites a turn for edit-and-resend. The turn keeps its identity and place. */
  updateTurnText(id, text, attachments = null) {
    if (attachments === null) this.#db.prepare("UPDATE agent_turns SET text = ? WHERE id = ?").run(text, id);
    else this.#db.prepare("UPDATE agent_turns SET text = ?, attachments_json = ? WHERE id = ?").run(text, JSON.stringify(attachments), id);
    return this.turn(id);
  }

  /**
   * Drops the turns that came after an edited one. Their answers were replies
   * to a question that no longer exists, so keeping them would put the model
   * in a conversation that never happened.
   */
  deleteTurnsAfter(sessionId, turnId) {
    const anchor = this.turn(turnId);
    if (!anchor) return 0;
    const result = this.#db
      .prepare("DELETE FROM agent_turns WHERE session_id = ? AND sequence > ?")
      .run(sessionId, anchor.sequence);
    return result.changes;
  }

  /** Puts a turn back in the queue so a retry or a resume re-answers it. */
  requeueTurn(id) {
    this.#db.prepare("UPDATE agent_turns SET state = 'pending', started_at = NULL, completed_at = NULL WHERE id = ?").run(id);
  }

  /**
   * Takes the lease when it is free, held by this owner, or expired. Returns
   * false rather than throwing so a second runtime simply declines the work.
   */
  acquireLease(sessionId, owner, expiresAt, now = new Date().toISOString()) {
    const result = this.#db
      .prepare(
        `UPDATE agent_sessions SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)`,
      )
      .run(owner, expiresAt, now, sessionId, owner, now);
    return result.changes > 0;
  }

  renewLease(sessionId, owner, expiresAt) {
    const result = this.#db
      .prepare("UPDATE agent_sessions SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?")
      .run(expiresAt, sessionId, owner);
    return result.changes > 0;
  }

  releaseLease(sessionId, owner) {
    this.#db
      .prepare("UPDATE agent_sessions SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?")
      .run(sessionId, owner);
  }

  /** Used by recovery, where the owner is a process that no longer exists. */
  clearLease(sessionId) {
    this.#db.prepare("UPDATE agent_sessions SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?").run(sessionId);
  }

  /** Sessions left running by a runtime that died: their lease has lapsed. */
  staleRunningSessions(now = new Date().toISOString()) {
    return this.#db
      .prepare(
        `SELECT id FROM agent_sessions
          WHERE status IN ('running', 'queued') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .all(now)
      .map((row) => row.id);
  }

  close() { this.#db.close(); }
}

function hydrate(row) {
  const { budgetJson, usageJson, ...rest } = row;
  return {
    ...rest,
    budget: budgetJson ? JSON.parse(budgetJson) : { ...DEFAULT_BUDGET },
    usage: usageJson ? JSON.parse(usageJson) : {},
  };
}
