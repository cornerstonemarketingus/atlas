/**
 * Scoped, provenance-carrying memory (blueprint §10).
 *
 * Memory is where an autonomous system quietly goes wrong: a guess written
 * down once becomes a "fact" three tasks later, a secret pasted into an
 * observation gets replayed into every future prompt, and one tenant's notes
 * leak into another's retrieval. This store makes each of those a refusal
 * rather than a convention:
 *
 *  - Every entry carries provenance (who produced it, from what) and a kind
 *    (observation | hypothesis | verified_fact | pattern). Promotion to
 *    verified_fact needs evidence and a verifier other than the producer;
 *    promotion to pattern needs a verified fact first.
 *  - Every read path takes a tenantId and filters in SQL, so another tenant's
 *    rows are never even loaded. Access rules are then evaluated per entry
 *    against the reading principal `{ userId, agentId, family, taskId?, projectIds? }`.
 *  - Family-scoped memory is readable only by agents of that family (or a user
 *    explicitly named as a reader). Crossing families is a separate,
 *    approved, redacted copy with a provenance link — never a widened ACL.
 *  - Corrections never overwrite: they create a new version and mark the old
 *    one superseded, so history is auditable. Deletion is the exception — it
 *    erases the content of the whole version lineage (and approved shares)
 *    and leaves a tombstone holding only the id and the deletion audit.
 *    `secure_delete` is on so erased text is also zeroed in the database file.
 *  - Secret-shaped strings are redacted before anything is written.
 *
 * Retrieval uses an FTS5 index when node:sqlite was built with it (Node 22's
 * bundled SQLite is) and falls back to LIKE otherwise; `searchMode` reports
 * which one is live.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { digest } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { redactSecrets } from "./redaction.mjs";

export const MEMORY_SCOPES = Object.freeze(["task", "agent", "family", "project", "user", "organization"]);
export const MEMORY_KINDS = Object.freeze(["observation", "hypothesis", "verified_fact", "pattern"]);
export const RETENTION_POLICIES = Object.freeze(["task", "days", "indefinite"]);
export const DEFAULT_MAX_CONTENT_CHARS = 16_384;
const DAY_MS = 86_400_000;

export class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

export function newMemoryId() {
  return `mem_${randomUUID().replaceAll("-", "")}`;
}

export class ScopedMemoryStore {
  #db;
  #clock;
  #maxContentChars;

  /**
   * @param filename a SQLite path, or ":memory:".
   * @param options.clock () => Date, injectable for retention tests.
   * @param options.maxContentChars size cap for one entry's text.
   */
  constructor(filename = ":memory:", { clock = () => new Date(), maxContentChars = DEFAULT_MAX_CONTENT_CHARS } = {}) {
    this.#db = new DatabaseSync(filename);
    this.#clock = clock;
    this.#maxContentChars = maxContentChars;
    this.#db.exec("PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        provenance TEXT NOT NULL,
        evidence TEXT,
        created_at TEXT NOT NULL,
        verified_at TEXT,
        verified_by TEXT,
        retention_policy TEXT NOT NULL,
        expires_at TEXT,
        readers TEXT NOT NULL,
        redacted INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        root_id TEXT NOT NULL,
        superseded_by TEXT,
        shared_from TEXT,
        deleted_at TEXT,
        deleted_by TEXT,
        deletion_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_tenant_scope ON memory_entries (tenant_id, scope, scope_ref);
      CREATE INDEX IF NOT EXISTS memory_root ON memory_entries (root_id);
      CREATE INDEX IF NOT EXISTS memory_shared_from ON memory_entries (shared_from);
      CREATE TABLE IF NOT EXISTS memory_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entry_id TEXT,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_audit_tenant ON memory_audit (tenant_id, seq);
    `);
    this.searchMode = "like";
    try {
      this.#db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(entry_id UNINDEXED, content, tokenize = 'unicode61')");
      this.searchMode = "fts5";
    } catch {
      this.searchMode = "like";
    }
  }

  close() {
    this.#db.close();
  }

  capabilities() {
    return { searchMode: this.searchMode, fts5: this.searchMode === "fts5", maxContentChars: this.#maxContentChars };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * @returns the stored entry (content already redacted).
   */
  write({ tenantId, owner, scope, scopeRef, kind = "observation", content, provenance, retention = { policy: "indefinite" }, access, now } = {}) {
    requireTenant(tenantId);
    requireString(owner, "owner");
    if (!MEMORY_SCOPES.includes(scope)) throw new MemoryError("INVALID_SCOPE", `Scope must be one of ${MEMORY_SCOPES.join(", ")}.`);
    requireString(scopeRef, "scopeRef");
    if (!MEMORY_KINDS.includes(kind)) throw new MemoryError("INVALID_KIND", `Kind must be one of ${MEMORY_KINDS.join(", ")}.`);
    if (kind === "verified_fact" || kind === "pattern") {
      throw new MemoryError("PROMOTION_REQUIRED", `A ${kind} cannot be written directly; write an observation and promote it with evidence.`);
    }
    const prov = normalizeProvenance(provenance, owner);
    const { text, redacted } = this.#prepareContent(content);
    const at = iso(now ?? this.#clock());
    const { policy, expiresAt } = normalizeRetention(retention, at);
    const readers = normalizeReaders(access?.readers ?? defaultReaders(scope, scopeRef, owner));
    const id = newMemoryId();
    this.#insert({
      id, tenantId, owner, scope, scopeRef, kind, content: text, provenance: prov, evidence: null, createdAt: at,
      verifiedAt: null, verifiedBy: null, retentionPolicy: policy, expiresAt, readers, redacted, version: 1, rootId: id,
      sharedFrom: null,
    });
    this.#audit(tenantId, prov.producedBy, "write", id, { scope, scopeRef, kind, redacted, contentDigest: digest(text) });
    return this.#getRow(tenantId, id, { includeDeleted: false });
  }

  /** New version with new content; the old one is kept and marked superseded. */
  correct(entryId, newContent, { tenantId, by, reason } = {}) {
    requireTenant(tenantId);
    requireString(by, "by");
    requireString(reason, "reason");
    const old = this.#requireLive(tenantId, entryId);
    if (old.superseded_by) throw new MemoryError("ALREADY_SUPERSEDED", `Entry ${entryId} was already corrected by ${old.superseded_by}; correct the latest version.`);
    const { text, redacted } = this.#prepareContent(newContent);
    const at = iso(this.#clock());
    // Corrected text has not been verified by anyone yet.
    const kind = old.kind === "verified_fact" || old.kind === "pattern" ? "observation" : old.kind;
    const id = newMemoryId();
    this.#db.exec("BEGIN");
    try {
      this.#insert({
        id, tenantId, owner: old.owner, scope: old.scope, scopeRef: old.scope_ref, kind, content: text,
        provenance: { source: "correction", sourceRefs: [old.id], producedBy: by, reason, correctedFrom: old.id },
        evidence: null, createdAt: at, verifiedAt: null, verifiedBy: null, retentionPolicy: old.retention_policy,
        expiresAt: old.expires_at, readers: JSON.parse(old.readers), redacted: redacted || old.redacted === 1,
        version: old.version + 1, rootId: old.root_id, sharedFrom: old.shared_from,
      });
      this.#db.prepare("UPDATE memory_entries SET superseded_by = ? WHERE id = ?").run(id, old.id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#audit(tenantId, by, "correct", id, { supersedes: old.id, reason, version: old.version + 1 });
    return this.#getRow(tenantId, id);
  }

  /**
   * observation|hypothesis → verified_fact (needs evidence and an independent
   * verifier); verified_fact → pattern (needs the same, from verified status).
   */
  promote(entryId, { tenantId, verifier, evidence, toKind } = {}) {
    requireTenant(tenantId);
    requireString(verifier, "verifier");
    const entry = this.#requireLive(tenantId, entryId);
    if (entry.superseded_by) throw new MemoryError("ALREADY_SUPERSEDED", "Only the latest version of an entry can be promoted.");
    const target = toKind ?? (entry.kind === "verified_fact" ? "pattern" : "verified_fact");
    if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((item) => item === null || item === undefined || item === "")) {
      throw new MemoryError("EVIDENCE_REQUIRED", "Promotion requires a non-empty evidence array.");
    }
    const provenance = JSON.parse(entry.provenance);
    if (verifier === entry.owner || verifier === provenance.producedBy) {
      throw new MemoryError("SELF_VERIFICATION", "The producer of an entry cannot verify it; a different agent or user must.");
    }
    if (target === "verified_fact") {
      if (!["observation", "hypothesis"].includes(entry.kind)) throw new MemoryError("INVALID_PROMOTION", `A ${entry.kind} cannot be promoted to verified_fact.`);
    } else if (target === "pattern") {
      if (entry.kind !== "verified_fact") throw new MemoryError("INVALID_PROMOTION", "Only a verified_fact can be promoted to a pattern.");
    } else {
      throw new MemoryError("INVALID_PROMOTION", `Cannot promote to '${target}'.`);
    }
    const at = iso(this.#clock());
    const priorEvidence = entry.evidence ? JSON.parse(entry.evidence) : [];
    this.#db.prepare("UPDATE memory_entries SET kind = ?, verified_at = ?, verified_by = ?, evidence = ? WHERE id = ? AND tenant_id = ?")
      .run(target, at, verifier, JSON.stringify([...priorEvidence, ...evidence]), entryId, tenantId);
    this.#audit(tenantId, verifier, "promote", entryId, { from: entry.kind, to: target, evidenceCount: evidence.length });
    return this.#getRow(tenantId, entryId);
  }

  /**
   * Copies an entry into another family's memory. Needs an explicit approver
   * (not the entry's own producer) and a redaction function; the copy links
   * back to its source through provenance.
   */
  shareAcrossFamily(entryId, { tenantId, toFamily, approvedBy, redact } = {}) {
    requireTenant(tenantId);
    requireString(toFamily, "toFamily");
    if (typeof approvedBy !== "string" || approvedBy.trim() === "") {
      throw new MemoryError("APPROVAL_REQUIRED", "Sharing memory across families requires an explicit approver.");
    }
    if (typeof redact !== "function") throw new MemoryError("REDACTION_REQUIRED", "Sharing memory across families requires a redaction function.");
    const entry = this.#requireLive(tenantId, entryId);
    const provenance = JSON.parse(entry.provenance);
    if (approvedBy === entry.owner || approvedBy === provenance.producedBy) {
      throw new MemoryError("SELF_APPROVAL", "The producer of an entry cannot approve sharing it.");
    }
    if (entry.scope === "family" && entry.scope_ref === toFamily) throw new MemoryError("SAME_FAMILY", "The entry already belongs to that family.");
    const redactedByCaller = String(redact(entry.content) ?? "");
    const { text, redacted } = this.#prepareContent(redactedByCaller);
    const at = iso(this.#clock());
    const id = newMemoryId();
    this.#insert({
      id, tenantId, owner: entry.owner, scope: "family", scopeRef: toFamily, kind: entry.kind, content: text,
      provenance: {
        source: "cross_family_share", sourceRefs: [entry.id], producedBy: provenance.producedBy, approvedBy,
        fromScope: entry.scope, fromScopeRef: entry.scope_ref,
      },
      evidence: entry.evidence ? JSON.parse(entry.evidence) : null, createdAt: at, verifiedAt: entry.verified_at,
      verifiedBy: entry.verified_by, retentionPolicy: entry.retention_policy, expiresAt: entry.expires_at,
      readers: [`family:${toFamily}`], redacted: redacted || redactedByCaller !== entry.content || entry.redacted === 1,
      version: 1, rootId: id, sharedFrom: entry.id,
    });
    this.#audit(tenantId, approvedBy, "share", id, { sourceId: entry.id, toFamily });
    return this.#getRow(tenantId, id);
  }

  /**
   * Erases the content of an entry's whole version lineage and of every
   * approved share made from it. Only tombstones remain.
   */
  delete(entryId, { tenantId, by, reason = "requested" } = {}) {
    requireTenant(tenantId);
    requireString(by, "by");
    const entry = this.#getRaw(tenantId, entryId);
    if (!entry) throw new MemoryError("NOT_FOUND", `No memory entry ${entryId} in this tenant.`);
    const erased = this.#erase(tenantId, entry.root_id, by, reason);
    this.#audit(tenantId, by, "delete", entryId, { reason, erasedIds: erased });
    return { id: entryId, deleted: true, erasedIds: erased };
  }

  /** Enforces retention: erases every entry whose expiry has passed. */
  expire(now = this.#clock()) {
    const at = iso(now);
    const due = this.#db.prepare("SELECT tenant_id, root_id FROM memory_entries WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?").all(at);
    const erased = [];
    const seen = new Set();
    for (const row of due) {
      const key = `${row.tenant_id}\u0000${row.root_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ids = this.#erase(row.tenant_id, row.root_id, "system:retention", "retention_expired", at);
      this.#audit(row.tenant_id, "system:retention", "expire", row.root_id, { erasedIds: ids }, at);
      erased.push(...ids);
    }
    return { expired: erased.length, ids: erased };
  }

  /** Task-retained memory ends with its task. */
  endTask(tenantId, taskId, { now = this.#clock() } = {}) {
    requireTenant(tenantId);
    const roots = this.#db.prepare("SELECT DISTINCT root_id FROM memory_entries WHERE tenant_id = ? AND deleted_at IS NULL AND retention_policy = 'task' AND scope = 'task' AND scope_ref = ?").all(tenantId, taskId);
    const erased = [];
    for (const { root_id: rootId } of roots) erased.push(...this.#erase(tenantId, rootId, "system:retention", "task_ended", iso(now)));
    this.#audit(tenantId, "system:retention", "end_task", null, { taskId, erasedIds: erased });
    return { expired: erased.length, ids: erased };
  }

  // -------------------------------------------------------------------------
  // Reads — every one is tenant-scoped in SQL and access-checked per entry.
  // -------------------------------------------------------------------------

  retrieve(tenantId, principal, { query, scopes, kinds, limit = 20, includeSuperseded = false } = {}) {
    requireTenant(tenantId);
    requirePrincipal(principal);
    const at = iso(this.#clock());
    const where = ["e.tenant_id = ?", "e.deleted_at IS NULL", "(e.expires_at IS NULL OR e.expires_at > ?)"];
    const params = [tenantId, at];
    if (!includeSuperseded) where.push("e.superseded_by IS NULL");
    if (scopes?.length) {
      where.push(`e.scope IN (${scopes.map(() => "?").join(",")})`);
      params.push(...scopes);
    }
    if (kinds?.length) {
      where.push(`e.kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }
    let sql;
    const terms = typeof query === "string" ? query.match(/[\p{L}\p{N}_]+/gu) ?? [] : [];
    if (terms.length > 0 && this.searchMode === "fts5") {
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      sql = `SELECT e.* FROM memory_fts f JOIN memory_entries e ON e.id = f.entry_id WHERE memory_fts MATCH ? AND ${where.join(" AND ")} ORDER BY bm25(memory_fts), e.created_at DESC`;
      params.unshift(match);
    } else {
      if (terms.length > 0) {
        where.push(`(${terms.map(() => "e.content LIKE ? ESCAPE '\\'").join(" OR ")})`);
        params.push(...terms.map((term) => `%${term.replace(/[%_\\]/gu, "\\$&")}%`));
      }
      sql = `SELECT e.* FROM memory_entries e WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC`;
    }
    const rows = this.#db.prepare(sql).all(...params);
    const readable = rows.filter((row) => canRead(row, principal)).slice(0, Math.max(0, limit)).map(toEntry);
    this.#audit(tenantId, principalLabel(principal), "read", null, { query: typeof query === "string" ? digest(query) : null, returned: readable.map((entry) => entry.id) });
    return readable;
  }

  /** One entry by id, if the principal may read it. Returns null otherwise. */
  get(tenantId, principal, entryId) {
    requireTenant(tenantId);
    requirePrincipal(principal);
    const row = this.#getRaw(tenantId, entryId);
    const ok = row && !row.deleted_at && canRead(row, principal);
    this.#audit(tenantId, principalLabel(principal), "read", entryId, { returned: ok ? [entryId] : [] });
    return ok ? toEntry(row) : null;
  }

  /** Version chain (oldest first) of the lineage an entry belongs to, filtered by access. */
  history(tenantId, principal, entryId) {
    requireTenant(tenantId);
    requirePrincipal(principal);
    const row = this.#getRaw(tenantId, entryId);
    if (!row) return [];
    const rows = this.#db.prepare("SELECT * FROM memory_entries WHERE tenant_id = ? AND root_id = ? ORDER BY version").all(tenantId, row.root_id);
    this.#audit(tenantId, principalLabel(principal), "read_history", entryId, {});
    return rows.filter((item) => item.deleted_at || canRead(item, principal)).map(toEntry);
  }

  /** Everything the principal can read in this tenant, including history. */
  export(tenantId, principal) {
    requireTenant(tenantId);
    requirePrincipal(principal);
    const rows = this.#db.prepare("SELECT * FROM memory_entries WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at, version").all(tenantId);
    const entries = rows.filter((row) => canRead(row, principal)).map(toEntry);
    this.#audit(tenantId, principalLabel(principal), "export", null, { count: entries.length });
    return JSON.stringify({ tenantId, exportedAt: iso(this.#clock()), principal, searchMode: this.searchMode, entries });
  }

  auditLog(tenantId, { limit = 1000 } = {}) {
    requireTenant(tenantId);
    return this.#db.prepare("SELECT * FROM memory_audit WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?").all(tenantId, limit)
      .reverse().map((row) => ({ seq: row.seq, at: row.at, tenantId: row.tenant_id, actor: row.actor, action: row.action, entryId: row.entry_id, detail: JSON.parse(row.detail) }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #prepareContent(content) {
    if (typeof content !== "string" || content.trim() === "") throw new MemoryError("INVALID_CONTENT", "Memory content must be a non-empty string.");
    if (content.length > this.#maxContentChars) {
      throw new MemoryError("CONTENT_TOO_LARGE", `Memory content is ${content.length} characters; the limit is ${this.#maxContentChars}. Store a summary and link the artifact instead.`);
    }
    return redactSecrets(content);
  }

  #insert(e) {
    this.#db.prepare(`INSERT INTO memory_entries (id, tenant_id, owner, scope, scope_ref, kind, content, provenance, evidence, created_at,
        verified_at, verified_by, retention_policy, expires_at, readers, redacted, version, root_id, superseded_by, shared_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
      e.id, e.tenantId, e.owner, e.scope, e.scopeRef, e.kind, e.content, JSON.stringify(e.provenance),
      e.evidence ? JSON.stringify(e.evidence) : null, e.createdAt, e.verifiedAt, e.verifiedBy, e.retentionPolicy,
      e.expiresAt, JSON.stringify(e.readers), e.redacted ? 1 : 0, e.version, e.rootId, e.sharedFrom,
    );
    if (this.searchMode === "fts5") this.#db.prepare("INSERT INTO memory_fts (entry_id, content) VALUES (?, ?)").run(e.id, e.content);
  }

  #erase(tenantId, rootId, by, reason, at = iso(this.#clock())) {
    const lineage = this.#db.prepare("SELECT id FROM memory_entries WHERE tenant_id = ? AND root_id = ?").all(tenantId, rootId).map((row) => row.id);
    const erased = [];
    const queue = [...lineage];
    const seen = new Set();
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.#getRaw(tenantId, id);
      if (!row) continue;
      // Shares carry (redacted) content derived from this lineage: erase them too.
      for (const share of this.#db.prepare("SELECT root_id FROM memory_entries WHERE tenant_id = ? AND shared_from = ?").all(tenantId, id)) {
        for (const member of this.#db.prepare("SELECT id FROM memory_entries WHERE tenant_id = ? AND root_id = ?").all(tenantId, share.root_id)) queue.push(member.id);
      }
      if (row.deleted_at) continue;
      this.#db.prepare(`UPDATE memory_entries SET content = '', provenance = '{}', evidence = NULL, readers = '[]', verified_by = NULL,
          deleted_at = ?, deleted_by = ?, deletion_reason = ? WHERE id = ? AND tenant_id = ?`).run(at, by, reason, id, tenantId);
      if (this.searchMode === "fts5") this.#db.prepare("DELETE FROM memory_fts WHERE entry_id = ?").run(id);
      erased.push(id);
    }
    // FTS5 keeps deleted terms in its segments until they are merged; merge
    // now so an erased entry's words do not survive in the index.
    if (erased.length > 0 && this.searchMode === "fts5") this.#db.exec("INSERT INTO memory_fts (memory_fts) VALUES ('optimize')");
    return erased;
  }

  #getRaw(tenantId, id) {
    if (typeof id !== "string") return null;
    return this.#db.prepare("SELECT * FROM memory_entries WHERE tenant_id = ? AND id = ?").get(tenantId, id) ?? null;
  }

  #requireLive(tenantId, id) {
    const row = this.#getRaw(tenantId, id);
    if (!row || row.deleted_at) throw new MemoryError("NOT_FOUND", `No memory entry ${id} in this tenant.`);
    return row;
  }

  #getRow(tenantId, id) {
    const row = this.#getRaw(tenantId, id);
    return row ? toEntry(row) : null;
  }

  #audit(tenantId, actor, action, entryId, detail, at = iso(this.#clock())) {
    this.#db.prepare("INSERT INTO memory_audit (at, tenant_id, actor, action, entry_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(at, tenantId, actor ?? "unknown", action, entryId ?? null, JSON.stringify(detail ?? {}));
  }
}

// ---------------------------------------------------------------------------
// Access rules
// ---------------------------------------------------------------------------

/**
 * Reader patterns: "*", "user:<glob>", "agent:<glob>", "family:<glob>",
 * "task:<id>", "project:<id>". Globs use "*".
 */
export function defaultReaders(scope, scopeRef, owner) {
  switch (scope) {
    case "task": return [owner, `task:${scopeRef}`];
    case "agent": return [owner];
    case "family": return [`family:${scopeRef}`];
    case "project": return [`project:${scopeRef}`];
    case "user": return [`user:${scopeRef}`];
    case "organization": return ["*"];
    default: return [owner];
  }
}

export function canRead(row, principal) {
  const readers = JSON.parse(row.readers);
  if (row.scope === "family") {
    // Family memory: agents of that family, or a user named explicitly.
    // Agent/family globs in the ACL cannot widen it to other families.
    if (principal.agentId && principal.family === row.scope_ref) return true;
    return readers.some((pattern) => pattern.startsWith("user:") && principal.userId && globMatch(pattern.slice(5), principal.userId));
  }
  if (principalMatches(row.owner, principal)) return true;
  return readers.some((pattern) => principalMatches(pattern, principal));
}

function principalMatches(pattern, principal) {
  if (pattern === "*") return true;
  const colon = pattern.indexOf(":");
  if (colon === -1) return principal.agentId === pattern || principal.userId === pattern;
  const type = pattern.slice(0, colon);
  const value = pattern.slice(colon + 1);
  switch (type) {
    case "user": return Boolean(principal.userId) && globMatch(value, principal.userId);
    case "agent": return Boolean(principal.agentId) && globMatch(value, principal.agentId);
    case "family": return Boolean(principal.agentId && principal.family) && globMatch(value, principal.family);
    case "task": return principal.taskId === value;
    case "project": return Array.isArray(principal.projectIds) && principal.projectIds.includes(value);
    default: return principal.agentId === pattern || principal.userId === pattern;
  }
}

function globMatch(glob, value) {
  if (typeof value !== "string") return false;
  const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "u").test(value);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEntry(row) {
  const deleted = Boolean(row.deleted_at);
  if (deleted) {
    return { id: row.id, tenant_id: row.tenant_id, deleted: true, deleted_at: row.deleted_at, deleted_by: row.deleted_by, deletion_reason: row.deletion_reason, version: row.version };
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    owner: row.owner,
    scope: row.scope,
    scope_ref: row.scope_ref,
    kind: row.kind,
    content: row.content,
    provenance: JSON.parse(row.provenance),
    evidence: row.evidence ? JSON.parse(row.evidence) : [],
    created_at: row.created_at,
    verified_at: row.verified_at,
    verified_by: row.verified_by,
    retention: { policy: row.retention_policy, expiresAt: row.expires_at },
    access: { readers: JSON.parse(row.readers) },
    redacted: row.redacted === 1,
    version: row.version,
    root_id: row.root_id,
    superseded_by: row.superseded_by,
    shared_from: row.shared_from,
  };
}

function normalizeProvenance(provenance, owner) {
  if (!provenance || typeof provenance !== "object") throw new MemoryError("PROVENANCE_REQUIRED", "Every memory entry needs provenance { source, sourceRefs, producedBy }.");
  requireString(provenance.source, "provenance.source");
  const sourceRefs = provenance.sourceRefs ?? [];
  if (!Array.isArray(sourceRefs) || sourceRefs.some((ref) => typeof ref !== "string")) throw new MemoryError("PROVENANCE_REQUIRED", "provenance.sourceRefs must be an array of strings.");
  const out = { source: provenance.source, sourceRefs, producedBy: provenance.producedBy ?? owner };
  if (provenance.toolCallId) out.toolCallId = String(provenance.toolCallId);
  return out;
}

function normalizeRetention(retention, createdAt) {
  const policy = retention?.policy ?? "indefinite";
  if (!RETENTION_POLICIES.includes(policy)) throw new MemoryError("INVALID_RETENTION", `Retention policy must be one of ${RETENTION_POLICIES.join(", ")}.`);
  if (policy === "indefinite") return { policy, expiresAt: null };
  if (policy === "days") {
    if (retention.expiresAt) return { policy, expiresAt: iso(new Date(retention.expiresAt)) };
    if (!Number.isFinite(retention.days) || retention.days <= 0) throw new MemoryError("INVALID_RETENTION", "A 'days' retention needs a positive `days` or an `expiresAt`.");
    return { policy, expiresAt: iso(new Date(Date.parse(createdAt) + retention.days * DAY_MS)) };
  }
  // 'task': lives until endTask(), with an optional hard backstop.
  return { policy, expiresAt: retention.expiresAt ? iso(new Date(retention.expiresAt)) : null };
}

function normalizeReaders(readers) {
  if (!Array.isArray(readers) || readers.some((reader) => typeof reader !== "string" || reader === "")) {
    throw new MemoryError("INVALID_ACCESS", "access.readers must be an array of principal patterns.");
  }
  return [...new Set(readers)];
}

function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || tenantId.trim() === "") throw new MemoryError("TENANT_REQUIRED", "A tenantId is required for every memory operation.");
}

function requirePrincipal(principal) {
  if (!principal || typeof principal !== "object" || (!principal.userId && !principal.agentId)) {
    throw new MemoryError("PRINCIPAL_REQUIRED", "A principal { userId?, agentId?, family? } with a user or agent id is required.");
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new MemoryError("INVALID_ARGUMENT", `${name} must be a non-empty string.`);
}

function principalLabel(principal) {
  return principal.agentId ? `agent:${principal.agentId}` : `user:${principal.userId}`;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new MemoryError("INVALID_TIME", "Invalid timestamp.");
  return date.toISOString();
}
