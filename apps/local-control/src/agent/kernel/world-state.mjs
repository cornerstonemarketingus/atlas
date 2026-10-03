import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Atlas's explicit world state: what Atlas believes is true about the user's
 * machines, repositories, files, browser resources, people, agents, tasks,
 * deployments, services, credentials, approvals, events and artifacts, as
 * typed entities and typed relations, updated by observations.
 *
 * The kernel reasons from this state rather than from chat history alone:
 * every action it takes is recorded as an observation that changes entities
 * (a file was read, a page was opened, an approval is pending), and every run
 * keeps an ordered trace of its phases.
 *
 * Safety rules:
 * - Credentials are references only (name, provider, scope, ref). No entity,
 *   of any type, may carry an attribute that looks like a secret value.
 * - Attributes are bounded in size; observations come from tool results and
 *   are data, never instructions.
 */

export const ENTITY_TYPES = Object.freeze([
  "user", "machine", "repository", "application", "browser_session", "browser_resource", "file", "database",
  "person", "agent", "task", "run", "deployment", "service", "credential", "approval", "event", "artifact", "organization",
]);

export const RELATIONS = Object.freeze([
  "uses", "owns", "calls", "depends_on", "deploys_to", "tests", "created_by", "approved_by", "failed_because",
  "replaced_by", "learned_from", "touched", "part_of", "assigned_to", "produced", "waits_on",
]);

const SECRET_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|private[_-]?key|credential[_-]?value|cookie|authorization/iu;
const CREDENTIAL_KEYS = new Set(["name", "provider", "scope", "ref", "status"]);
const MAX_ATTRS_BYTES = 8 * 1024;
const MAX_KEY = 512;

export class WorldStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorldStateError";
    this.code = code;
  }
}

/** Drops secret-looking keys at any depth. */
function scrub(value, depth = 0) {
  if (Array.isArray(value)) return depth > 4 ? [] : value.slice(0, 50).map((entry) => scrub(entry, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 4) return {};
    const out = {};
    for (const [key, entry] of Object.entries(value)) if (!SECRET_KEY.test(key) && entry !== undefined && typeof entry !== "function") out[key] = scrub(entry, depth + 1);
    return out;
  }
  return value;
}

/** Removes anything that could be a secret; credentials keep only their reference fields. */
export function cleanAttributes(type, attrs = {}) {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return {};
  const out = {};
  for (const [key, value] of Object.entries(scrub(attrs))) {
    if (type === "credential" && !CREDENTIAL_KEYS.has(key)) continue;
    out[key] = value;
  }
  let text = JSON.stringify(out);
  if (text.length > MAX_ATTRS_BYTES) {
    // Keep the entity, drop the bulk: long values are truncated rather than stored whole.
    for (const key of Object.keys(out)) if (typeof out[key] === "string" && out[key].length > 500) out[key] = `${out[key].slice(0, 500)}…`;
    text = JSON.stringify(out);
    if (text.length > MAX_ATTRS_BYTES) throw new WorldStateError("TOO_LARGE", `Attributes for a ${type} are too large.`);
  }
  return out;
}

export const entityId = (type, key) => `${type}:${key}`;

export class WorldState {
  #db;
  #clock;

  constructor(filename = ":memory:", { clock = () => new Date() } = {}) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.#clock = clock;
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS world_entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        attrs TEXT NOT NULL,
        version INTEGER NOT NULL,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS world_entities_type ON world_entities(type, updated_at);
      CREATE TABLE IF NOT EXISTS world_relations (
        from_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        to_id TEXT NOT NULL,
        source TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_id, relation, to_id)
      );
      CREATE INDEX IF NOT EXISTS world_relations_to ON world_relations(to_id, relation);
      CREATE TABLE IF NOT EXISTS world_trace (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        phase TEXT NOT NULL,
        data TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `);
  }

  close() { this.#db.close(); }

  #now() { return this.#clock().toISOString(); }

  #row(row) {
    return row ? { id: row.id, type: row.type, key: row.key, attrs: JSON.parse(row.attrs), version: row.version, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  /** Creates or merges an entity; returns it. Attributes merge shallowly; `null` removes one. */
  upsert({ type, key, attrs = {}, source = null }) {
    if (!ENTITY_TYPES.includes(type)) throw new WorldStateError("UNKNOWN_TYPE", `Unknown entity type: ${type}.`);
    const cleanKey = String(key ?? "").trim().slice(0, MAX_KEY);
    if (!cleanKey) throw new WorldStateError("INVALID_KEY", `A ${type} needs a key.`);
    const id = entityId(type, cleanKey);
    const existing = this.get(id);
    const merged = { ...(existing?.attrs ?? {}), ...cleanAttributes(type, attrs) };
    for (const [name, value] of Object.entries(merged)) if (value === null) delete merged[name];
    const now = this.#now();
    const text = JSON.stringify(cleanAttributes(type, merged));
    if (existing) {
      if (text !== JSON.stringify(existing.attrs)) {
        this.#db.prepare("UPDATE world_entities SET attrs = ?, version = version + 1, source = ?, updated_at = ? WHERE id = ?").run(text, source, now, id);
      } else {
        this.#db.prepare("UPDATE world_entities SET updated_at = ? WHERE id = ?").run(now, id);
      }
    } else {
      this.#db.prepare("INSERT INTO world_entities (id, type, key, attrs, version, source, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)").run(id, type, cleanKey, text, source, now, now);
    }
    return this.get(id);
  }

  get(id) {
    return this.#row(this.#db.prepare("SELECT * FROM world_entities WHERE id = ?").get(String(id)));
  }

  find({ type = null, limit = 50 } = {}) {
    const rows = type
      ? this.#db.prepare("SELECT * FROM world_entities WHERE type = ? ORDER BY updated_at DESC, id LIMIT ?").all(type, limit)
      : this.#db.prepare("SELECT * FROM world_entities ORDER BY updated_at DESC, id LIMIT ?").all(limit);
    return rows.map((row) => this.#row(row));
  }

  relate(fromId, relation, toId, { source = null } = {}) {
    if (!RELATIONS.includes(relation)) throw new WorldStateError("UNKNOWN_RELATION", `Unknown relation: ${relation}.`);
    if (!this.get(fromId) || !this.get(toId)) throw new WorldStateError("UNKNOWN_ENTITY", `Both ends of "${relation}" must exist.`);
    this.#db.prepare("INSERT OR IGNORE INTO world_relations (from_id, relation, to_id, source, created_at) VALUES (?, ?, ?, ?, ?)").run(fromId, relation, toId, source, this.#now());
  }

  /** Relations touching an entity, in either direction. */
  relations(id) {
    return this.#db.prepare("SELECT from_id, relation, to_id FROM world_relations WHERE from_id = ? OR to_id = ? ORDER BY created_at, from_id, to_id").all(id, id)
      .map((row) => ({ from: row.from_id, relation: row.relation, to: row.to_id }));
  }

  /**
   * Applies one observation atomically:
   *   { source, entities: [{ type, key, attrs }], relations: [{ from, relation, to }] }
   * where `from`/`to` are entity ids or { type, key } references.
   */
  apply({ source = null, entities = [], relations = [] } = {}) {
    const resolve = (ref) => (typeof ref === "string" ? ref : entityId(ref.type, String(ref.key).trim().slice(0, MAX_KEY)));
    this.#db.exec("BEGIN");
    try {
      const applied = entities.map((entity) => this.upsert({ ...entity, source: entity.source ?? source }));
      for (const relation of relations) this.relate(resolve(relation.from), relation.relation, resolve(relation.to), { source });
      this.#db.exec("COMMIT");
      return applied;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Appends a phase to a run's trace. */
  trace(runId, phase, data = {}) {
    const next = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM world_trace WHERE run_id = ?").get(runId).seq;
    this.#db.prepare("INSERT INTO world_trace (run_id, seq, phase, data, at) VALUES (?, ?, ?, ?, ?)").run(runId, next, phase, JSON.stringify(data).slice(0, 16 * 1024), this.#now());
    return next;
  }

  traceOf(runId) {
    return this.#db.prepare("SELECT seq, phase, data, at FROM world_trace WHERE run_id = ? ORDER BY seq").all(runId)
      .map((row) => ({ seq: row.seq, phase: row.phase, at: row.at, data: JSON.parse(row.data) }));
  }

  /**
   * What the kernel perceives before acting: the focus entities, what they are
   * related to, and the most recent entities of the given types — as compact
   * lines for a prompt.
   */
  snapshot({ focus = [], types = [], limit = 20, depth = 1 } = {}) {
    const seen = new Map();
    const add = (entity) => { if (entity && !seen.has(entity.id) && seen.size < limit) { seen.set(entity.id, entity); return true; } return false; };
    const edges = [];
    const edgeKeys = new Set();
    // Breadth-first from the focus, `depth` hops out. Per-call events are
    // left out: they are the trace's business, and they would crowd out the
    // files, pages and people the work actually touched.
    let frontier = [];
    for (const id of focus) if (add(this.get(id))) frontier.push(id);
    for (let hop = 0; hop < depth && frontier.length; hop += 1) {
      const next = [];
      for (const id of frontier) {
        for (const edge of this.relations(id)) {
          const other = edge.from === id ? edge.to : edge.from;
          if (other.startsWith("event:")) continue;
          const key = `${edge.from}\0${edge.relation}\0${edge.to}`;
          if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push(edge); }
          if (add(this.get(other))) next.push(other);
        }
      }
      frontier = next;
    }
    for (const type of types) for (const entity of this.find({ type, limit: 5 })) add(entity);
    const entities = [...seen.values()];
    const lines = entities.map((entity) => `${entity.id} ${JSON.stringify(entity.attrs).slice(0, 300)}`);
    for (const edge of edges.slice(0, limit)) lines.push(`${edge.from} -${edge.relation}-> ${edge.to}`);
    return { entities, relations: edges, text: lines.join("\n") };
  }
}
