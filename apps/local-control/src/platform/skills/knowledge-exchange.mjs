import { digest, newId } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { redactSecrets } from "../memory/redaction.mjs";
import { actorKey } from "./approvals.mjs";
import { SkillError } from "./package.mjs";

/**
 * Knowledge exchange (blueprint §13 I): publishing a reviewed, reusable
 * solution from one agent family to others, or tenant-wide.
 *
 * - Redaction happens at submission, before anything is stored: secrets
 *   (the memory redactor's patterns), e-mail addresses, and any extra terms
 *   the author names (customer names, hostnames). The raw text is never
 *   written, so neither the reviewer nor a consumer can see it.
 * - Publication needs a reviewer who is not the author. Review happens on
 *   the redacted text — exactly what consumers will get.
 * - Consumers see only published entries addressed to their family (or the
 *   whole tenant), as redacted content plus provenance: who wrote it, who
 *   reviewed it, which task it came from, what kinds of redaction were
 *   applied, and the digest of the published content.
 */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Redacts every string in a JSON value. Returns `{ value, kinds }`. */
export function redactValue(value, { terms = [] } = {}) {
  const kinds = new Set();
  const termPatterns = terms.filter((t) => typeof t === "string" && t.trim().length >= 2)
    .map((t) => new RegExp(escapeRegExp(t.trim()), "giu"));
  const redactString = (text) => {
    const secrets = redactSecrets(text);
    secrets.kinds.forEach((k) => kinds.add(k));
    let out = secrets.text.replace(EMAIL, () => { kinds.add("email"); return "[REDACTED:email]"; });
    for (const pattern of termPatterns) out = out.replace(pattern, () => { kinds.add("term"); return "[REDACTED:term]"; });
    return out;
  };
  const walk = (node) => {
    if (typeof node === "string") return redactString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  return { value: walk(value), kinds: [...kinds].sort() };
}

export class KnowledgeExchange {
  #db;
  #clock;

  constructor({ db, clock = () => new Date() }) {
    this.#db = db;
    this.#clock = clock;
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, content_json TEXT NOT NULL, content_digest TEXT NOT NULL,
        redactions_json TEXT NOT NULL, author TEXT NOT NULL, author_family TEXT NOT NULL, source_task_id TEXT,
        audience_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('in_review','published','rejected','withdrawn')),
        reviewer TEXT, review_notes TEXT, reviewed_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_entries_tenant ON knowledge_entries(tenant_id, status);
    `);
  }

  /**
   * `audience` is `{ scope: "tenant" }` or `{ scope: "families", families: [...] }`.
   * `content` is any JSON value (text, steps, a template definition).
   */
  submit(tenantId, { title, content, author, authorFamily, audience, sourceTaskId = null, redactTerms = [] }) {
    if (typeof title !== "string" || !title.trim()) throw new SkillError("INVALID_INPUT", "A knowledge entry needs a title.");
    if (content === undefined || content === null) throw new SkillError("INVALID_INPUT", "A knowledge entry needs content.");
    if (typeof authorFamily !== "string" || !authorFamily) throw new SkillError("INVALID_INPUT", "The author's family is required.");
    const scope = audience?.scope;
    if (scope !== "tenant" && !(scope === "families" && Array.isArray(audience.families) && audience.families.length > 0 && audience.families.every((f) => typeof f === "string" && f))) {
      throw new SkillError("INVALID_INPUT", "audience is { scope: 'tenant' } or { scope: 'families', families: [...] }.");
    }
    const cleanAudience = scope === "tenant" ? { scope } : { scope, families: [...new Set(audience.families)].sort() };
    const redactedTitle = redactValue(title.trim(), { terms: redactTerms });
    const redacted = redactValue(content, { terms: redactTerms });
    const kinds = [...new Set([...redactedTitle.kinds, ...redacted.kinds])].sort();
    const id = `kno_${newId("artifact").slice(4)}`;
    this.#db.prepare(
      `INSERT INTO knowledge_entries (id, tenant_id, title, content_json, content_digest, redactions_json, author, author_family,
                                      source_task_id, audience_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_review', ?)`,
    ).run(id, tenantId, redactedTitle.value, JSON.stringify(redacted.value), digest(redacted.value), JSON.stringify(kinds),
      actorKey(author), authorFamily, sourceTaskId, JSON.stringify(cleanAudience), this.#clock().toISOString());
    return this.#entry(tenantId, id, { internal: true });
  }

  /** A reviewer other than the author publishes or rejects an entry in review. */
  review(tenantId, id, { reviewer, decision, notes = null }) {
    const reviewerKey = actorKey(reviewer);
    if (decision !== "publish" && decision !== "reject") throw new SkillError("INVALID_INPUT", "decision must be 'publish' or 'reject'.");
    const row = this.#row(tenantId, id);
    if (!row) throw new SkillError("NOT_FOUND", "No such knowledge entry in this tenant.");
    if (row.status !== "in_review") throw new SkillError("INVALID_STATE", `The entry is '${row.status}', not in review.`);
    if (row.author === reviewerKey) throw new SkillError("SELF_REVIEW", "The author cannot review their own entry.");
    if (digest(JSON.parse(row.content_json)) !== row.content_digest) throw new SkillError("INTEGRITY_FAILURE", "The entry changed after submission.");
    this.#db.prepare("UPDATE knowledge_entries SET status = ?, reviewer = ?, review_notes = ?, reviewed_at = ? WHERE id = ? AND tenant_id = ? AND status = 'in_review'")
      .run(decision === "publish" ? "published" : "rejected", reviewerKey, notes, this.#clock().toISOString(), id, tenantId);
    return this.#entry(tenantId, id, { internal: true });
  }

  withdraw(tenantId, id, { actor }) {
    const row = this.#row(tenantId, id);
    if (!row) throw new SkillError("NOT_FOUND", "No such knowledge entry in this tenant.");
    const key = actorKey(actor);
    if (key !== row.author && key !== row.reviewer) throw new SkillError("FORBIDDEN", "Only the author or reviewer can withdraw an entry.");
    this.#db.prepare("UPDATE knowledge_entries SET status = 'withdrawn' WHERE id = ? AND tenant_id = ?").run(id, tenantId);
    return this.#entry(tenantId, id, { internal: true });
  }

  /** Published entries visible to a consuming family: redacted content plus provenance only. */
  listFor(tenantId, { family }) {
    return this.#db.prepare("SELECT id FROM knowledge_entries WHERE tenant_id = ? AND status = 'published' ORDER BY reviewed_at, id").all(tenantId)
      .map((row) => this.getFor(tenantId, row.id, { family }))
      .filter(Boolean);
  }

  getFor(tenantId, id, { family }) {
    const row = this.#row(tenantId, id);
    if (!row || row.status !== "published") return null;
    const audience = JSON.parse(row.audience_json);
    const visible = audience.scope === "tenant" || audience.families.includes(family) || row.author_family === family;
    return visible ? this.#entry(tenantId, id, { internal: false }) : null;
  }

  #row(tenantId, id) {
    return this.#db.prepare("SELECT * FROM knowledge_entries WHERE id = ? AND tenant_id = ?").get(id, tenantId) ?? null;
  }

  #entry(tenantId, id, { internal }) {
    const row = this.#row(tenantId, id);
    const published = {
      id: row.id,
      title: row.title,
      content: JSON.parse(row.content_json),
      provenance: {
        author: row.author, authorFamily: row.author_family, reviewer: row.reviewer, reviewedAt: row.reviewed_at,
        sourceTaskId: row.source_task_id, contentDigest: row.content_digest, redactions: JSON.parse(row.redactions_json),
      },
    };
    if (!internal) return published;
    return { ...published, status: row.status, audience: JSON.parse(row.audience_json), reviewNotes: row.review_notes, createdAt: row.created_at };
  }
}
