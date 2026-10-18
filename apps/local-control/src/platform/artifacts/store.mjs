import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import {
  ARTIFACT_KINDS, ARTIFACT_MEDIA_TYPES, ARTIFACT_SHA256_PATTERN, SCHEMA_VERSION, assertArtifactRecord, newId,
} from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Content-addressed artifact store on this machine: what Atlas made, so the
 * owner can see it (issue #354).
 *
 * - Bytes live once under `<root>/blobs/<first two hex>/<sha256>`; the path is
 *   derived only from a digest that matched /^[0-9a-f]{64}$/, so no caller
 *   input ever becomes part of a file path.
 * - Each tenant has its own metadata rows (SQLite, `<root>/artifacts.sqlite`).
 *   A tenant can read bytes only through a row it owns, even when another
 *   tenant stored identical bytes.
 * - Only the media types the `Artifact` contract allows for the declared kind
 *   are accepted, and the bytes must look like that type (magic bytes for
 *   binary formats; valid UTF-8 or JSON for text formats), so a record can
 *   not label an executable as a video.
 * - Each artifact is size-limited (`maxBytes`, 1 GiB by default; text and
 *   JSON formats are also capped at `maxTextBytes`, 32 MiB, because they are
 *   checked in memory).
 *
 * Writing an artifact (for producers such as Genesis or a render worker):
 *
 *   const { artifact, created } = await artifacts.put({
 *     tenantId: "local",
 *     kind: "video",                    // ARTIFACT_KINDS
 *     mediaType: "video/mp4",           // must be allowed for the kind
 *     provenance: { runId, step: "render", source: "render" },
 *     path: "/tmp/out.mp4",             // or bytes: Buffer | Uint8Array | string
 *     name: "intro.mp4",                // optional download name
 *     previewUrl: null,                 // optional same-origin path or http(s) URL
 *   });
 *
 * `put` is idempotent per tenant and digest: storing the same bytes again
 * returns the existing record with `created: false` (its first provenance is
 * kept). It throws `ArtifactError` with a stable `code` on refusal.
 */

export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_TEXT_BYTES = 32 * 1024 * 1024;
const TENANT_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const MAX_LIST = 500;
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
const JSON_TYPES = new Set(["application/json", "model/gltf+json", "application/vnd.atlas.site-manifest+json"]);

export class ArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
  }
}

/** True when the leading bytes are what the declared binary media type starts with. */
function signatureMatches(mediaType, head) {
  const ascii = (offset, text) => head.length >= offset + text.length && head.subarray(offset, offset + text.length).toString("latin1") === text;
  const bytes = (...values) => head.length >= values.length && values.every((value, index) => head[index] === value);
  switch (mediaType) {
    case "video/mp4": return ascii(4, "ftyp");
    case "video/webm": return bytes(0x1a, 0x45, 0xdf, 0xa3);
    case "model/gltf-binary": return ascii(0, "glTF");
    case "application/pdf": return ascii(0, "%PDF-");
    case "application/zip": return ascii(0, "PK\u0003\u0004") || ascii(0, "PK\u0005\u0006");
    case "image/png": return bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg": return bytes(0xff, 0xd8, 0xff);
    case "image/webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    default: return false;
  }
}

function checkContent(mediaType, head, whole) {
  if (TEXT_TYPES.has(mediaType) || JSON_TYPES.has(mediaType)) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(whole); } catch { return "is not valid UTF-8 text"; }
    if (text.includes("\u0000")) return "contains NUL bytes, so it is not text";
    if (JSON_TYPES.has(mediaType)) { try { JSON.parse(text); } catch { return "is not valid JSON"; } }
    return null;
  }
  return signatureMatches(mediaType, head) ? null : `does not look like ${mediaType}`;
}

export class ArtifactStore {
  #db;
  #now;

  /**
   * @param {{ root: string, filename?: string, maxBytes?: number, maxTextBytes?: number, now?: () => Date }} options
   */
  constructor({ root, filename = join(root, "artifacts.sqlite"), maxBytes = DEFAULT_MAX_BYTES, maxTextBytes = DEFAULT_MAX_TEXT_BYTES, now = () => new Date() }) {
    if (!root) throw new ArtifactError("INVALID_INPUT", "The artifact store needs a root directory.");
    this.root = root;
    this.maxBytes = maxBytes;
    this.maxTextBytes = maxTextBytes;
    this.#now = now;
    mkdirSync(root, { recursive: true });
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        name TEXT,
        provenance_json TEXT NOT NULL,
        run_id TEXT NOT NULL,
        preview_url TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (tenant_id, sha256)
      );
      CREATE INDEX IF NOT EXISTS artifacts_by_tenant ON artifacts (tenant_id, created_at DESC);
    `);
  }

  close() { this.#db.close(); }

  /** Where the bytes for a digest live. Only ever called with a validated digest. */
  #blobPath(sha256) {
    if (!ARTIFACT_SHA256_PATTERN.test(sha256)) throw new ArtifactError("INVALID_DIGEST", "An artifact digest is 64 lowercase hex characters.");
    return join(this.root, "blobs", sha256.slice(0, 2), sha256);
  }

  /**
   * Stores bytes (or a file) and records them for the tenant.
   * @param {{ tenantId: string, kind: string, mediaType: string, provenance: { runId: string, step: string, source?: string },
   *   bytes?: Buffer | Uint8Array | string, path?: string, name?: string | null, previewUrl?: string | null }} input
   * @returns {Promise<{ artifact: object, created: boolean }>}
   */
  async put({ tenantId, kind, mediaType, provenance, bytes, path, name = null, previewUrl = null } = {}) {
    if (typeof tenantId !== "string" || !TENANT_PATTERN.test(tenantId)) throw new ArtifactError("INVALID_TENANT", "A tenant id is required.");
    if (!ARTIFACT_KINDS.includes(kind)) throw new ArtifactError("INVALID_KIND", `Unknown artifact kind '${String(kind)}'.`);
    // The allowlist is checked before a single byte is written.
    if (!ARTIFACT_MEDIA_TYPES[kind].includes(mediaType)) {
      throw new ArtifactError("MEDIA_TYPE_NOT_ALLOWED", `'${String(mediaType)}' is not an allowed media type for a ${kind} artifact.`);
    }
    if ((bytes === undefined) === (path === undefined)) throw new ArtifactError("INVALID_INPUT", "Pass exactly one of bytes or path.");
    const isText = TEXT_TYPES.has(mediaType) || JSON_TYPES.has(mediaType);
    const limit = isText ? Math.min(this.maxBytes, this.maxTextBytes) : this.maxBytes;

    const tmpDir = join(this.root, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.part`);
    let sha256, size, head, whole = null;
    try {
      if (bytes !== undefined) {
        const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.isBuffer(bytes) ? bytes : bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
        if (!buffer) throw new ArtifactError("INVALID_INPUT", "bytes must be a Buffer, Uint8Array or string.");
        if (buffer.length > limit) throw new ArtifactError("TOO_LARGE", `The artifact is ${buffer.length} bytes; the limit for ${mediaType} is ${limit}.`);
        sha256 = createHash("sha256").update(buffer).digest("hex");
        size = buffer.length;
        head = buffer.subarray(0, 16);
        whole = buffer;
        const problem = checkContent(mediaType, head, whole);
        if (problem) throw new ArtifactError("CONTENT_MISMATCH", `The content ${problem}.`);
        await writeFile(tmp, buffer, { mode: 0o600 });
      } else {
        if (typeof path !== "string" || !path) throw new ArtifactError("INVALID_INPUT", "path must be a file path.");
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) throw new ArtifactError("INVALID_INPUT", "path is not a readable regular file.");
        if (info.size > limit) throw new ArtifactError("TOO_LARGE", `The artifact is ${info.size} bytes; the limit for ${mediaType} is ${limit}.`);
        const hash = createHash("sha256");
        const chunks = [];
        let seen = 0;
        const firstBytes = [];
        await pipeline(createReadStream(path), new Transform({
          transform(chunk, _encoding, done) {
            seen += chunk.length;
            if (seen > limit) return done(new ArtifactError("TOO_LARGE", `The file grew past the ${limit}-byte limit while it was read.`));
            hash.update(chunk);
            if (firstBytes.reduce((n, c) => n + c.length, 0) < 16) firstBytes.push(chunk.subarray(0, 16));
            if (isText) chunks.push(chunk);
            done(null, chunk);
          },
        }), createWriteStream(tmp, { mode: 0o600 }));
        sha256 = hash.digest("hex");
        size = seen;
        head = Buffer.concat(firstBytes).subarray(0, 16);
        if (isText) whole = Buffer.concat(chunks);
        const problem = checkContent(mediaType, head, whole);
        if (problem) throw new ArtifactError("CONTENT_MISMATCH", `The content ${problem}.`);
      }

      const existing = this.get(tenantId, sha256);
      const blob = this.#blobPath(sha256);
      const blobExists = await access(blob).then(() => true, () => false);
      if (!blobExists) {
        await mkdir(join(this.root, "blobs", sha256.slice(0, 2)), { recursive: true });
        await rename(tmp, blob);
      }
      if (existing) return { artifact: existing, created: false };

      const record = assertArtifactRecord({
        schemaVersion: SCHEMA_VERSION,
        id: newId("artifact"),
        tenantId,
        kind,
        sha256,
        size,
        mediaType,
        name,
        provenance,
        previewUrl,
        createdAt: this.#now().toISOString(),
      });
      const inserted = this.#db.prepare(`INSERT OR IGNORE INTO artifacts (id, tenant_id, sha256, kind, media_type, size, name, provenance_json, run_id, preview_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, tenantId, sha256, kind, mediaType, size, name, JSON.stringify(provenance), provenance.runId, previewUrl, record.createdAt);
      // A concurrent put of the same bytes won the insert: return its record.
      if (inserted.changes === 0) return { artifact: this.get(tenantId, sha256), created: false };
      return { artifact: record, created: true };
    } catch (error) {
      if (error?.code === "SCHEMA_VIOLATION") throw new ArtifactError("INVALID_INPUT", error.message);
      throw error;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  #record(row) {
    if (!row) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      id: row.id,
      tenantId: row.tenant_id,
      kind: row.kind,
      sha256: row.sha256,
      size: row.size,
      mediaType: row.media_type,
      name: row.name,
      provenance: JSON.parse(row.provenance_json),
      previewUrl: row.preview_url,
      createdAt: row.created_at,
    };
  }

  /** The tenant's record for a digest, or null (also null for a malformed digest). */
  get(tenantId, sha256) {
    if (typeof sha256 !== "string" || !ARTIFACT_SHA256_PATTERN.test(sha256)) return null;
    return this.#record(this.#db.prepare("SELECT * FROM artifacts WHERE tenant_id = ? AND sha256 = ?").get(String(tenantId), sha256));
  }

  /**
   * The tenant's artifacts, newest first.
   * @param {string} tenantId
   * @param {{ kind?: string, runId?: string, limit?: number }} [filter]
   */
  list(tenantId, { kind = null, runId = null, limit = 100 } = {}) {
    const clauses = ["tenant_id = ?"], values = [String(tenantId)];
    if (kind) { clauses.push("kind = ?"); values.push(String(kind)); }
    if (runId) { clauses.push("run_id = ?"); values.push(String(runId)); }
    const bounded = Math.max(1, Math.min(MAX_LIST, Number.isInteger(limit) ? limit : 100));
    return this.#db.prepare(`SELECT * FROM artifacts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${bounded}`).all(...values).map((row) => this.#record(row));
  }

  /**
   * The record and blob path for bytes the tenant may read, or null. This is
   * the only way to reach a blob: the tenant must own a row for the digest.
   */
  locate(tenantId, sha256) {
    const artifact = this.get(tenantId, sha256);
    return artifact ? { artifact, path: this.#blobPath(artifact.sha256) } : null;
  }
}
