import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { TRUST_LEVELS, WorkerRegistry, capabilityGaps } from "../workers/registry.mjs";
import { validateRenderJob } from "../render/render-policy.mjs";

/**
 * Atlas Nodes: machines the owner brings (a laptop, a desktop, a friend's GPU
 * box) that dial OUT to this daemon, pull render jobs, run them in their own
 * container sandbox and upload the outputs. PROGRAM.md Phase 4 / §4.9.
 *
 * This service is the daemon half. It does not have its own trust model:
 *
 * - **Identity and trust are the worker registry's.** A node credential is a
 *   random 32-byte token the owner mints; only its sha256 is stored (the
 *   paired-device mechanism). The node's first call registers a registry
 *   worker, which starts `untrusted`. Only the owner's approval
 *   (`approveEnrollment`) makes it claimable; revocation ends the token and
 *   the worker together and puts its in-flight jobs back in the queue.
 * - **One claimant per job.** A claim is a guarded UPDATE from `queued` to
 *   `claimed` with a fresh claim id and an expiry. Every later call for that
 *   job must present the current claim id; a lost claim answers CLAIM_LOST.
 * - **Leases expire.** Heartbeats and status reports extend a claim. A claim
 *   that is not extended expires: the job is re-queued for a different node,
 *   at most `maxAttempts - 1` times (one retry by default), then fails.
 *   A job whose outputs were confirmed (`succeeded`) is never re-queued.
 * - **Outputs are verified.** Each upload is size-limited, hashed while it
 *   streams, refused when the digest differs from the one the node declared,
 *   and stored through the artifact store (which checks the content type).
 *   A job completes only when every declared output was uploaded under the
 *   current claim with the digest the completion names.
 * - **Tenant-scoped.** A node belongs to the tenant whose owner minted it and
 *   only ever sees that tenant's jobs.
 *
 * Times are integer milliseconds from the injected clock.
 */

export const NODE_JOB_STATES = Object.freeze(["queued", "claimed", "succeeded", "failed", "cancelled"]);
export const TERMINAL_JOB_STATES = Object.freeze(["succeeded", "failed", "cancelled"]);
export const DEFAULT_CLAIM_TTL_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
export const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 ** 3;
const SHA256 = /^[0-9a-f]{64}$/u;
const MESSAGE_LIMIT = 500;

/** Render outputs a node may return, and how the artifact store files them. */
export const NODE_OUTPUT_TYPES = Object.freeze({
  ".mp4": { kind: "video", mediaType: "video/mp4" },
  ".webm": { kind: "video", mediaType: "video/webm" },
  ".png": { kind: "file", mediaType: "image/png" },
  ".jpg": { kind: "file", mediaType: "image/jpeg" },
  ".jpeg": { kind: "file", mediaType: "image/jpeg" },
  ".webp": { kind: "file", mediaType: "image/webp" },
});

export class NodeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "NodeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const extensionOf = (path) => { const dot = path.lastIndexOf("."); return dot < 0 ? "" : path.slice(dot).toLowerCase(); };
const bounded = (value) => (typeof value === "string" ? value.slice(0, MESSAGE_LIMIT) : null);

export function outputTypeFor(path) {
  return NODE_OUTPUT_TYPES[extensionOf(path)] ?? null;
}

/** What a render job needs from a node: a container sandbox and the tool; a GPU only when asked for. */
export function nodeRequirements({ tool, minVramGb = 0, cpu = undefined }) {
  const requirements = { terminal: "container", render: [tool] };
  if (Number.isFinite(minVramGb) && minVramGb > 0) requirements.gpu = { minVramGb };
  if (cpu && (cpu.minCores || cpu.minMemoryGiB)) requirements.cpu = { minCores: cpu.minCores ?? 0, minMemoryGiB: cpu.minMemoryGiB ?? 0 };
  return requirements;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export class NodeService {
  #db;
  #registry;
  #artifacts;
  #root;
  #clock;
  #isOwner;
  #claimTtlMs;
  #heartbeatTtlMs;
  #maxAttempts;
  #maxUploadBytes;
  #maxInputBytes;
  #events = new EventEmitter();

  /**
   * @param options.db          filename or DatabaseSync (node credentials and jobs; the registry shares it unless given)
   * @param options.registry    an existing WorkerRegistry (default: one on the same database)
   * @param options.artifacts   ArtifactStore that receives verified outputs
   * @param options.root        directory for staged job inputs and upload temp files
   * @param options.isOwner     ({ tenantId, userId }) => boolean, who may mint, approve and revoke nodes
   * @param options.clock       () => ms
   */
  constructor({ db = ":memory:", registry = undefined, artifacts, root, isOwner, clock = () => Date.now(), claimTtlMs = DEFAULT_CLAIM_TTL_MS,
    heartbeatTtlMs = undefined, maxAttempts = DEFAULT_MAX_ATTEMPTS, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES, maxInputBytes = DEFAULT_MAX_INPUT_BYTES } = {}) {
    if (typeof isOwner !== "function") throw new NodeError("INVALID_ARGUMENT", "isOwner is required: only the owner approves nodes.");
    if (!artifacts || typeof artifacts.put !== "function") throw new NodeError("INVALID_ARGUMENT", "An artifact store is required for node outputs.");
    if (typeof root !== "string" || !isAbsolute(root)) throw new NodeError("INVALID_ARGUMENT", "root must be an absolute directory.");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new NodeError("INVALID_ARGUMENT", "maxAttempts must be a positive integer.");
    this.#db = typeof db === "string" ? new DatabaseSync(db) : db;
    this.#clock = clock;
    this.#isOwner = isOwner;
    this.#claimTtlMs = claimTtlMs;
    this.#heartbeatTtlMs = heartbeatTtlMs ?? Math.max(claimTtlMs, 30_000);
    this.#registry = registry ?? new WorkerRegistry(this.#db, { clock: () => new Date(this.#clock()), heartbeatTtlMs: this.#heartbeatTtlMs, isOwner });
    this.#artifacts = artifacts;
    this.#root = root;
    this.#maxAttempts = maxAttempts;
    this.#maxUploadBytes = maxUploadBytes;
    this.#maxInputBytes = maxInputBytes;
    this.#events.setMaxListeners(0);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS node_credentials (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        worker_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, revoked_by TEXT,
        PRIMARY KEY (tenant_id, id));
      CREATE TABLE IF NOT EXISTS node_jobs (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, spec_json TEXT NOT NULL, inputs_json TEXT NOT NULL,
        requirements_json TEXT NOT NULL, risk TEXT NOT NULL, tags_json TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL, excluded_json TEXT NOT NULL DEFAULT '[]',
        claimant TEXT, claim_id TEXT, claim_expires_at INTEGER, deadline_at INTEGER NOT NULL,
        status_json TEXT, outputs_json TEXT, error TEXT, end_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, terminated_at INTEGER, termination_reason TEXT);
      CREATE INDEX IF NOT EXISTS node_jobs_queue ON node_jobs (tenant_id, state, created_at);
      CREATE TABLE IF NOT EXISTS node_job_outputs (
        job_id TEXT NOT NULL, claim_id TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
        artifact_id TEXT NOT NULL, artifact_kind TEXT NOT NULL, media_type TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (job_id, claim_id, path));
      CREATE TABLE IF NOT EXISTS node_job_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, action TEXT NOT NULL,
        worker_id TEXT, detail TEXT, at INTEGER NOT NULL);
    `);
  }

  get registry() { return this.#registry; }
  now() { return this.#clock(); }
  close() { this.#db.close(); }

  // ---------------------------------------------------------------- owner

  #requireOwner(tenantId, userId, action) {
    if (typeof tenantId !== "string" || !tenantId) throw new NodeError("TENANT_REQUIRED", "A tenantId is required.");
    if (this.#isOwner({ tenantId, userId }) !== true) throw new NodeError("NOT_OWNER", `Only the tenant owner can ${action} a node.`);
  }

  /** Owner mints a node credential. The token is returned once and stored only as its sha256. */
  createNode({ tenantId, name, by }) {
    this.#requireOwner(tenantId, by, "add");
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "Atlas Node";
    const id = `node_${randomUUID().replaceAll("-", "")}`;
    const token = randomBytes(32).toString("base64url");
    this.#db.prepare("INSERT INTO node_credentials (tenant_id, id, name, token_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tenantId, id, label, digest(token), by, this.#clock());
    return { node: this.getNode(tenantId, id), token };
  }

  #credentialRow(row) {
    if (!row) return null;
    return { tenantId: row.tenant_id, id: row.id, name: row.name, workerId: row.worker_id, createdAt: row.created_at, revokedAt: row.revoked_at };
  }

  getNode(tenantId, nodeId) {
    const credential = this.#credentialRow(this.#db.prepare("SELECT * FROM node_credentials WHERE tenant_id = ? AND id = ?").get(tenantId, nodeId));
    if (!credential) return null;
    const worker = credential.workerId ? this.#registry.getWorker(tenantId, credential.workerId) : null;
    return {
      id: credential.id, name: credential.name, createdAt: new Date(credential.createdAt).toISOString(),
      revoked: credential.revokedAt !== null || Boolean(worker?.revoked),
      status: credential.revokedAt !== null || worker?.revoked ? "revoked" : !worker ? "waiting_for_node" : worker.trust === "untrusted" ? "awaiting_approval" : "approved",
      worker: worker ? { id: worker.id, trust: worker.trust, capabilities: worker.capabilities, lastHeartbeatAt: worker.lastHeartbeatAt, load: worker.load, availability: worker.availability } : null,
    };
  }

  listNodes(tenantId) {
    return this.#db.prepare("SELECT id FROM node_credentials WHERE tenant_id = ? ORDER BY created_at, rowid").all(tenantId).map((row) => this.getNode(tenantId, row.id));
  }

  /** Owner approval: the node's registry worker goes untrusted -> enrolled, and only then can it claim. */
  approve(tenantId, nodeId, { approver }) {
    this.#requireOwner(tenantId, approver, "approve");
    const credential = this.#requireCredential(tenantId, nodeId);
    if (credential.revokedAt !== null) throw new NodeError("NODE_REVOKED", "This node was revoked; mint a new one.");
    if (!credential.workerId) throw new NodeError("NODE_NOT_CONNECTED", "The node has not connected yet; start it, then approve what it declared.");
    this.#registry.approveEnrollment(tenantId, credential.workerId, { approver });
    return this.getNode(tenantId, nodeId);
  }

  /** Owner revocation: the token stops working at once and every job it holds goes back to the queue. */
  revoke(tenantId, nodeId, { by, reason = "revoked by owner" }) {
    this.#requireOwner(tenantId, by, "revoke");
    const credential = this.#requireCredential(tenantId, nodeId);
    if (credential.revokedAt === null) {
      this.#db.prepare("UPDATE node_credentials SET revoked_at = ?, revoked_by = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").run(this.#clock(), by, tenantId, nodeId);
    }
    if (credential.workerId) {
      this.#registry.revoke(tenantId, credential.workerId, { by, reason: bounded(reason) ?? "revoked" });
      for (const job of this.#db.prepare("SELECT id FROM node_jobs WHERE tenant_id = ? AND state = 'claimed' AND claimant = ?").all(tenantId, credential.workerId)) {
        this.#releaseClaim(job.id, { reason: "node_revoked", exclude: true });
      }
    }
    return this.getNode(tenantId, nodeId);
  }

  #requireCredential(tenantId, nodeId) {
    const credential = this.#credentialRow(this.#db.prepare("SELECT * FROM node_credentials WHERE tenant_id = ? AND id = ?").get(tenantId, nodeId));
    if (!credential) throw new NodeError("NODE_NOT_FOUND", "No such node in this tenant.");
    return credential;
  }

  // ---------------------------------------------------------------- node identity

  /** The credential for a presented node token, or null (unknown, revoked, or its worker revoked). */
  authenticate(token) {
    if (typeof token !== "string" || token.length < 32 || token.length > 256) return null;
    const credential = this.#credentialRow(this.#db.prepare("SELECT * FROM node_credentials WHERE token_hash = ? AND revoked_at IS NULL").get(digest(token)));
    if (!credential) return null;
    if (credential.workerId && this.#registry.getWorker(credential.tenantId, credential.workerId)?.revoked) return null;
    return credential;
  }

  /** A node announces what it can do. The first announcement registers an untrusted registry worker. */
  register(credential, { capabilities, load = 0 } = {}) {
    // node:sqlite is synchronous, so nothing interleaves between this read and the guarded write.
    const current = this.#requireCredential(credential.tenantId, credential.id);
    if (!current.workerId) {
      const worker = this.#registry.register({ tenantId: credential.tenantId, name: credential.name, kind: "local", capabilities, registeredBy: `node:${credential.id}` });
      this.#db.prepare("UPDATE node_credentials SET worker_id = ? WHERE tenant_id = ? AND id = ? AND worker_id IS NULL").run(worker.id, credential.tenantId, credential.id);
      current.workerId = worker.id;
    }
    credential.workerId = current.workerId;
    return this.heartbeat(credential, { capabilities, load });
  }

  /** Proves the node is alive (registry heartbeat) and extends every claim it holds. */
  heartbeat(credential, { capabilities = undefined, load = 0 } = {}) {
    if (!credential.workerId) throw new NodeError("NODE_NOT_REGISTERED", "Register the node before sending heartbeats.");
    const worker = this.#registry.heartbeat(credential.tenantId, credential.workerId, { load, capabilities });
    const now = this.#clock();
    this.sweep();
    this.#db.prepare("UPDATE node_jobs SET claim_expires_at = ?, updated_at = ? WHERE tenant_id = ? AND state = 'claimed' AND claimant = ?")
      .run(now + this.#claimTtlMs, now, credential.tenantId, credential.workerId);
    return { worker, node: this.getNode(credential.tenantId, credential.id) };
  }

  // ---------------------------------------------------------------- the approval gate

  /**
   * Why `worker` may not claim a job of this risk with these requirements
   * (empty = it may). This is the only gate between a node and a job.
   */
  claimGaps(worker, { requirements, risk = "moderate" }, now = this.#clock()) {
    const gaps = [];
    if (!worker) return ["node is not registered"];
    if (worker.revoked) gaps.push("revoked");
    const minTrust = this.#registry.minimumTrustFor(risk);
    if (TRUST_LEVELS.indexOf(worker.trust) < TRUST_LEVELS.indexOf(minTrust)) gaps.push(`trust '${worker.trust}' below '${minTrust}': the owner has not approved this node`);
    if (!worker.lastHeartbeatAt || now - Date.parse(worker.lastHeartbeatAt) > this.#heartbeatTtlMs) gaps.push("heartbeat stale");
    gaps.push(...capabilityGaps(worker.capabilities, requirements));
    return gaps;
  }

  /** Approved nodes that could take a job with these requirements right now. */
  eligibleNodes(tenantId, { requirements, risk = "moderate" }) {
    return this.#registry.listWorkers(tenantId)
      .filter((worker) => this.claimGaps(worker, { requirements, risk }).length === 0)
      .map((worker) => ({ id: worker.id, name: worker.name, capabilities: worker.capabilities }));
  }

  // ---------------------------------------------------------------- jobs

  #event(tenantId, jobId, action, workerId = null, detail = null) {
    this.#db.prepare("INSERT INTO node_job_events (tenant_id, job_id, action, worker_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tenantId, jobId, action, workerId, detail === null ? null : JSON.stringify(detail), this.#clock());
    this.#events.emit("change", { tenantId, jobId, action });
  }

  jobEvents(tenantId, jobId) {
    return this.#db.prepare("SELECT action, worker_id AS workerId, detail, at FROM node_job_events WHERE tenant_id = ? AND job_id = ? ORDER BY seq").all(tenantId, jobId)
      .map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
  }

  #jobRow(row) {
    if (!row) return null;
    return {
      id: row.id, tenantId: row.tenant_id, render: JSON.parse(row.spec_json), inputs: JSON.parse(row.inputs_json).map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
      requirements: JSON.parse(row.requirements_json), risk: row.risk, tags: JSON.parse(row.tags_json), state: row.state,
      attempts: row.attempts, maxAttempts: row.max_attempts, excluded: JSON.parse(row.excluded_json), claimant: row.claimant,
      claimExpiresAt: row.claim_expires_at, deadlineAt: row.deadline_at, status: row.status_json ? JSON.parse(row.status_json) : null,
      outputs: row.outputs_json ? JSON.parse(row.outputs_json) : [], error: row.error, endReason: row.end_reason,
      createdAt: row.created_at, updatedAt: row.updated_at, terminatedAt: row.terminated_at, terminationReason: row.termination_reason,
    };
  }

  getJob(tenantId, jobId) { return this.#jobRow(this.#db.prepare("SELECT * FROM node_jobs WHERE tenant_id = ? AND id = ?").get(tenantId, jobId)); }
  /** Maintenance read across tenants (the compute provider addresses jobs by id). */
  getJobById(jobId) { return this.#jobRow(this.#db.prepare("SELECT * FROM node_jobs WHERE id = ?").get(jobId)); }
  listJobs(tenantId, { limit = 100 } = {}) {
    return this.#db.prepare(`SELECT * FROM node_jobs WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${Math.max(1, Math.min(500, Number(limit) || 100))}`).all(tenantId).map((row) => this.#jobRow(row));
  }
  /** Maintenance scan for the reconciler: jobs whose instance has not been terminated. */
  listLiveJobs() { return this.#db.prepare("SELECT * FROM node_jobs WHERE terminated_at IS NULL ORDER BY created_at").all().map((row) => this.#jobRow(row)); }

  /**
   * Queues a render job. Inputs are copied out of `workspace` now (regular
   * files inside it only), so a node can only ever fetch what was declared.
   */
  async submit({ tenantId, render, workspace = null, tags = [], deadlineAt, risk = "moderate", minVramGb = 0, cpu = undefined }) {
    if (typeof tenantId !== "string" || !tenantId) throw new NodeError("TENANT_REQUIRED", "A tenantId is required.");
    const spec = validateRenderJob(render);
    for (const output of spec.outputs) {
      if (!outputTypeFor(output)) throw new NodeError("OUTPUT_TYPE_NOT_ALLOWED", `Output '${output}' has no artifact type; node outputs must be ${Object.keys(NODE_OUTPUT_TYPES).join(", ")}.`);
    }
    if (!Number.isFinite(deadlineAt)) throw new NodeError("INVALID_ARGUMENT", "deadlineAt is required.");
    this.#registry.minimumTrustFor(risk);
    const id = `nj_${randomUUID().replaceAll("-", "")}`;
    const staged = [];
    if (spec.inputs.length) {
      if (typeof workspace !== "string" || !isAbsolute(workspace)) throw new NodeError("INVALID_WORKSPACE", "Jobs with inputs need an absolute workspace.");
      const root = await realpath(workspace).catch(() => { throw new NodeError("INVALID_WORKSPACE", "The workspace does not exist."); });
      const dir = join(this.#root, "inputs", id);
      await mkdir(dir, { recursive: true });
      let total = 0;
      try {
        for (const [index, rel] of spec.inputs.entries()) {
          const real = await realpath(join(root, ...rel.split("/"))).catch(() => null);
          if (!real) throw new NodeError("INPUT_MISSING", `Input '${rel}' does not exist.`);
          if (!inside(root, real)) throw new NodeError("INPUT_OUTSIDE_WORKSPACE", `Input '${rel}' resolves outside the workspace.`);
          const info = await lstat(real);
          if (!info.isFile()) throw new NodeError("INPUT_NOT_FILE", `Input '${rel}' is not a regular file.`);
          total += info.size;
          if (total > this.#maxInputBytes) throw new NodeError("INPUT_TOO_LARGE", `Inputs exceed ${this.#maxInputBytes} bytes.`);
          const target = join(dir, String(index));
          await copyFile(real, target, fsConstants.COPYFILE_EXCL);
          staged.push({ path: rel, sha256: await sha256File(target), bytes: info.size });
        }
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    }
    const requirements = nodeRequirements({ tool: spec.tool, minVramGb, cpu });
    const now = this.#clock();
    this.#db.prepare(`INSERT INTO node_jobs (id, tenant_id, spec_json, inputs_json, requirements_json, risk, tags_json, state, max_attempts, deadline_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, tenantId, JSON.stringify(spec), JSON.stringify(staged), JSON.stringify(requirements), risk,
      JSON.stringify(tags.map(String)), this.#maxAttempts, deadlineAt, now, now);
    this.#event(tenantId, id, "queued", null, { tool: spec.tool, requirements });
    return this.getJob(tenantId, id);
  }

  /**
   * Expires claims that were not extended and jobs past their deadline.
   * Safe to call from anywhere, any number of times.
   */
  sweep() {
    const now = this.#clock();
    for (const row of this.#db.prepare("SELECT id FROM node_jobs WHERE state = 'claimed' AND claim_expires_at <= ?").all(now)) {
      this.#releaseClaim(row.id, { reason: "lease_expired", exclude: true, onlyIfExpiredAt: now });
    }
    for (const row of this.#db.prepare("SELECT id, tenant_id FROM node_jobs WHERE state IN ('queued', 'claimed') AND deadline_at <= ?").all(now)) {
      const { changes } = this.#db.prepare("UPDATE node_jobs SET state = 'failed', end_reason = 'deadline', error = ?, claimant = NULL, claim_id = NULL, updated_at = ? WHERE id = ? AND state IN ('queued', 'claimed')")
        .run("The job passed its deadline before a node finished it.", now, row.id);
      if (changes) this.#event(row.tenant_id, row.id, "failed", null, { reason: "deadline" });
    }
  }

  /**
   * Ends the current claim. The job goes back to the queue (excluding the
   * node that lost it) while attempts remain, otherwise it fails.
   */
  #releaseClaim(jobId, { reason, exclude, retryable = true, error = null, onlyIfExpiredAt = undefined }) {
    const row = this.#db.prepare("SELECT * FROM node_jobs WHERE id = ? AND state = 'claimed'").get(jobId);
    if (!row) return false;
    const now = this.#clock();
    const excluded = JSON.parse(row.excluded_json);
    if (exclude && row.claimant && !excluded.includes(row.claimant)) excluded.push(row.claimant);
    const requeue = retryable && row.attempts < row.max_attempts && row.deadline_at > now;
    const guard = onlyIfExpiredAt === undefined ? "" : " AND claim_expires_at <= ?";
    const params = onlyIfExpiredAt === undefined ? [] : [onlyIfExpiredAt];
    const { changes } = requeue
      ? this.#db.prepare(`UPDATE node_jobs SET state = 'queued', claimant = NULL, claim_id = NULL, claim_expires_at = NULL, excluded_json = ?, status_json = NULL, updated_at = ? WHERE id = ? AND state = 'claimed' AND claim_id = ?${guard}`)
        .run(JSON.stringify(excluded), now, jobId, row.claim_id, ...params)
      : this.#db.prepare(`UPDATE node_jobs SET state = 'failed', end_reason = ?, error = ?, claimant = NULL, claim_id = NULL, claim_expires_at = NULL, excluded_json = ?, updated_at = ? WHERE id = ? AND state = 'claimed' AND claim_id = ?${guard}`)
        .run(reason, bounded(error) ?? `The job's node was lost (${reason}) and it has no attempts left.`, JSON.stringify(excluded), now, jobId, row.claim_id, ...params);
    if (changes) this.#event(row.tenant_id, jobId, requeue ? "requeued" : "failed", row.claimant, { reason, attempts: row.attempts });
    return changes > 0;
  }

  /**
   * One node asks for one job. Returns the claim, or null when nothing it may
   * run is queued. A job goes to exactly one claimant: the guarded UPDATE
   * only succeeds while the job is still `queued`.
   */
  claim(credential) {
    this.sweep();
    const worker = credential.workerId ? this.#registry.getWorker(credential.tenantId, credential.workerId) : null;
    if (!worker) throw new NodeError("NODE_NOT_REGISTERED", "Register the node before claiming jobs.");
    const now = this.#clock();
    const queued = this.#db.prepare("SELECT * FROM node_jobs WHERE tenant_id = ? AND state = 'queued' AND deadline_at > ? ORDER BY created_at, rowid").all(credential.tenantId, now);
    for (const row of queued) {
      const job = this.#jobRow(row);
      if (job.excluded.includes(worker.id)) continue;
      if (this.claimGaps(worker, job, now).length) continue;
      const claimId = randomBytes(16).toString("hex");
      const { changes } = this.#db.prepare(`UPDATE node_jobs SET state = 'claimed', claimant = ?, claim_id = ?, claim_expires_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND state = 'queued' AND attempts < max_attempts`).run(worker.id, claimId, now + this.#claimTtlMs, now, job.id);
      if (!changes) continue;
      this.#event(credential.tenantId, job.id, "claimed", worker.id, { attempt: job.attempts + 1 });
      const claimed = this.getJob(credential.tenantId, job.id);
      return { id: claimed.id, claimId, claimExpiresAt: claimed.claimExpiresAt, render: claimed.render, inputs: claimed.inputs, requirements: claimed.requirements, attempt: claimed.attempts };
    }
    return null;
  }

  /** Why this worker could not claim anything right now (for a node's logs; never other tenants' data). */
  claimRefusal(credential) {
    const worker = credential.workerId ? this.#registry.getWorker(credential.tenantId, credential.workerId) : null;
    if (!worker) return "node is not registered";
    if (worker.trust === "untrusted") return "waiting for the owner to approve this node";
    return "no queued job matches this node";
  }

  /** Resolves when a job is queued for `tenantId`, or after `ms`. */
  waitForWork(tenantId, ms, signal = undefined) {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); this.#events.off("change", onChange); signal?.removeEventListener?.("abort", done); resolve(); };
      const onChange = (event) => { if (event.tenantId === tenantId && (event.action === "queued" || event.action === "requeued")) done(); };
      this.#events.on("change", onChange);
      signal?.addEventListener?.("abort", done, { once: true });
      timer = setTimeout(done, Math.max(0, ms));
    });
  }

  /** Resolves on any change to `jobId`, or after `ms`. */
  waitForJob(jobId, ms, signal = undefined) {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); this.#events.off("change", onChange); signal?.removeEventListener?.("abort", done); resolve(); };
      const onChange = (event) => { if (event.jobId === jobId) done(); };
      this.#events.on("change", onChange);
      signal?.addEventListener?.("abort", done, { once: true });
      timer = setTimeout(done, Math.max(0, ms));
    });
  }

  /** The job, if `credential` holds its current claim; otherwise CLAIM_LOST. */
  #requireClaim(credential, jobId, claimId) {
    this.sweep();
    const row = this.#db.prepare("SELECT * FROM node_jobs WHERE tenant_id = ? AND id = ?").get(credential.tenantId, jobId);
    if (!row) throw new NodeError("JOB_NOT_FOUND", "No such job.");
    if (row.state !== "claimed" || !credential.workerId || row.claimant !== credential.workerId || typeof claimId !== "string" || row.claim_id !== claimId) {
      throw new NodeError("CLAIM_LOST", row.state === "cancelled" ? "The job was cancelled." : "This node no longer holds the job's claim.");
    }
    return this.#jobRow(row);
  }

  /** A node reports progress. This extends its claim. */
  reportStatus(credential, jobId, { claimId, progress = null, message = null } = {}) {
    const job = this.#requireClaim(credential, jobId, claimId);
    const now = this.#clock();
    const status = { progress: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null, message: bounded(message), at: now };
    this.#db.prepare("UPDATE node_jobs SET status_json = ?, claim_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'claimed' AND claim_id = ?")
      .run(JSON.stringify(status), now + this.#claimTtlMs, now, job.id, claimId);
    return { state: "claimed", claimExpiresAt: now + this.#claimTtlMs };
  }

  /** The path of a staged input for the current claimant. */
  inputFor(credential, jobId, index, claimId) {
    this.#requireClaim(credential, jobId, claimId);
    const row = this.#db.prepare("SELECT inputs_json FROM node_jobs WHERE id = ?").get(jobId);
    const inputs = JSON.parse(row.inputs_json);
    if (!Number.isInteger(index) || index < 0 || index >= inputs.length) throw new NodeError("INPUT_NOT_FOUND", "No such input.");
    return { ...inputs[index], file: join(this.#root, "inputs", jobId, String(index)) };
  }

  /**
   * Stores one declared output from the current claimant. The bytes are
   * hashed while they stream; more than the limit, or a digest other than
   * the declared one, is refused and nothing is kept.
   */
  async uploadOutput(credential, jobId, { claimId, path, sha256, stream, declaredBytes = null }) {
    const job = this.#requireClaim(credential, jobId, claimId);
    if (!job.render.outputs.includes(path)) throw new NodeError("OUTPUT_NOT_DECLARED", `'${String(path).slice(0, 200)}' is not a declared output of this job.`);
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new NodeError("DIGEST_REQUIRED", "Each upload must declare its sha256 (64 lowercase hex).");
    const limit = Math.min(this.#maxUploadBytes, job.render.maxOutputBytes);
    if (declaredBytes !== null && declaredBytes > limit) throw new NodeError("OUTPUT_TOO_LARGE", `The output is larger than ${limit} bytes.`);
    const type = outputTypeFor(path);
    const tmpDir = join(this.#root, "uploads");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.part`);
    try {
      const hash = createHash("sha256");
      let seen = 0;
      await pipeline(stream, new Transform({
        transform(chunk, _encoding, done) {
          seen += chunk.length;
          if (seen > limit) return done(new NodeError("OUTPUT_TOO_LARGE", `The output is larger than ${limit} bytes.`));
          hash.update(chunk);
          done(null, chunk);
        },
      }), createWriteStream(tmp, { mode: 0o600 }));
      const actual = hash.digest("hex");
      if (actual !== sha256) throw new NodeError("DIGEST_MISMATCH", "The uploaded bytes do not match the declared sha256; the output was refused.");
      // The claim may have been lost while the bytes streamed.
      this.#requireClaim(credential, jobId, claimId);
      const { artifact } = await this.#artifacts.put({
        tenantId: credential.tenantId, kind: type.kind, mediaType: type.mediaType, path: tmp,
        name: path.slice(path.lastIndexOf("/") + 1), provenance: { runId: jobId, step: "render", source: "atlas-node" },
      });
      if (artifact.sha256 !== actual) throw new NodeError("DIGEST_MISMATCH", "The artifact store recorded a different digest.");
      this.#db.prepare(`INSERT OR REPLACE INTO node_job_outputs (job_id, claim_id, path, sha256, bytes, artifact_id, artifact_kind, media_type, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(jobId, claimId, path, actual, seen, artifact.id, type.kind, type.mediaType, this.#clock());
      this.#event(credential.tenantId, jobId, "output", credential.workerId, { path, sha256: actual, bytes: seen });
      return { path, sha256: actual, bytes: seen, artifact: { id: artifact.id, sha256: artifact.sha256, kind: artifact.kind } };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * The node says it is done. Succeeds only when every declared output was
   * uploaded under this claim with exactly the digest named here; from then
   * on the job is never re-queued or claimed again.
   */
  complete(credential, jobId, { claimId, files } = {}) {
    const job = this.#requireClaim(credential, jobId, claimId);
    if (!Array.isArray(files)) throw new NodeError("INVALID_ARGUMENT", "files must list each output with its sha256.");
    const uploaded = new Map(this.#db.prepare("SELECT * FROM node_job_outputs WHERE job_id = ? AND claim_id = ?").all(jobId, claimId).map((row) => [row.path, row]));
    const named = new Map(files.map((file) => [file?.path, file?.sha256]));
    const outputs = [];
    for (const path of job.render.outputs) {
      const row = uploaded.get(path);
      if (!row) throw new NodeError("OUTPUT_MISSING", `Output '${path}' was not uploaded.`);
      if (named.get(path) !== row.sha256) throw new NodeError("DIGEST_MISMATCH", `Output '${path}' does not match the uploaded sha256.`);
      outputs.push({ path, sha256: row.sha256, bytes: row.bytes, artifactId: row.artifact_id, kind: row.artifact_kind, mediaType: row.media_type });
    }
    const now = this.#clock();
    const { changes } = this.#db.prepare(`UPDATE node_jobs SET state = 'succeeded', outputs_json = ?, end_reason = 'succeeded', claim_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'claimed' AND claim_id = ? AND claimant = ?`).run(JSON.stringify(outputs), now, jobId, claimId, credential.workerId);
    if (!changes) throw new NodeError("CLAIM_LOST", "This node no longer holds the job's claim.");
    this.#event(credential.tenantId, jobId, "succeeded", credential.workerId, { outputs: outputs.length });
    return this.getJob(credential.tenantId, jobId);
  }

  /** The node could not run the job. Retryable failures go back to the queue for another node. */
  fail(credential, jobId, { claimId, error = null, retryable = false } = {}) {
    this.#requireClaim(credential, jobId, claimId);
    this.#releaseClaim(jobId, { reason: retryable ? "node_declined" : "node_failed", exclude: true, retryable: retryable === true, error: bounded(error) ?? "The node reported a failure." });
    return this.getJob(credential.tenantId, jobId);
  }

  /** Compute provider terminate: the job stops being runnable; a node holding it gets CLAIM_LOST. Idempotent. */
  terminate(jobId, reason = "requested") {
    const now = this.#clock();
    const row = this.#db.prepare("SELECT tenant_id FROM node_jobs WHERE id = ?").get(jobId);
    if (!row) return null;
    const { changes } = this.#db.prepare("UPDATE node_jobs SET state = 'cancelled', end_reason = ?, claimant = NULL, claim_id = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ? AND state IN ('queued', 'claimed')")
      .run(reason, now, jobId);
    if (changes) this.#event(row.tenant_id, jobId, "cancelled", null, { reason });
    this.#db.prepare("UPDATE node_jobs SET terminated_at = ?, termination_reason = ? WHERE id = ? AND terminated_at IS NULL").run(now, reason, jobId);
    return this.getJobById(jobId);
  }

  /** Marks a job past its max lifetime as terminated (the provider-side max lifetime). */
  expireDeadline(jobId) {
    const job = this.getJobById(jobId);
    if (job && job.terminatedAt === null && job.deadlineAt <= this.#clock()) return this.terminate(jobId, "max_lifetime");
    return job;
  }
}
