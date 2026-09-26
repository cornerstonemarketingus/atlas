import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Verified-performance store (blueprint §13 A).
 *
 * Every finished piece of delegated work leaves one evaluation result:
 * who did it (agentId and/or role), what kind of work it was, how it ended,
 * what it cost and how long it took. Scoring reads these rows with two rules:
 *
 * - Only a VERIFIED outcome is a success. An agent that *claims* it finished
 *   ("unverified") scores exactly like one that failed, so self-reported
 *   success can never raise an agent's standing.
 * - Old evidence fades. Each sample is weighted by 0.5^(age / halfLife), and
 *   a score is only reported as `sufficient` once the agent has at least
 *   `minSamples` results for that task kind; below that the caller must
 *   treat the agent as unknown rather than as good or bad.
 *
 * Tenant isolation is structural: every row carries tenant_id and every
 * query filters on it.
 */

export const OUTCOMES = Object.freeze(["verified", "failed", "unverified"]);
export const DEFAULT_HALF_LIFE_MS = 14 * 86_400_000;
export const DEFAULT_MIN_SAMPLES = 3;

export class PerformanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PerformanceError";
    this.code = code;
  }
}

function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || !tenantId) throw new PerformanceError("TENANT_REQUIRED", "A tenantId is required.");
}

function nonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new PerformanceError("INVALID_ARGUMENT", `'${field}' must be a non-negative integer.`);
  return value;
}

export class PerformanceStore {
  #db;
  #clock;

  constructor(filenameOrDb = ":memory:", { clock = () => new Date() } = {}) {
    this.#db = typeof filenameOrDb === "string" ? new DatabaseSync(filenameOrDb) : filenameOrDb;
    this.#clock = clock;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_results (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL, id TEXT NOT NULL UNIQUE,
        agent_id TEXT, role TEXT, task_kind TEXT NOT NULL, task_id TEXT,
        outcome TEXT NOT NULL, cost_micro_usd INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        evidence_json TEXT, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS evaluation_results_agent_idx ON evaluation_results(tenant_id, agent_id, task_kind);
      CREATE INDEX IF NOT EXISTS evaluation_results_role_idx ON evaluation_results(tenant_id, role, task_kind);
      CREATE TRIGGER IF NOT EXISTS evaluation_results_no_update BEFORE UPDATE ON evaluation_results
        BEGIN SELECT RAISE(ABORT, 'evaluation_results are append-only'); END;
    `);
  }

  get db() { return this.#db; }
  close() { this.#db.close(); }

  /**
   * Appends one result. `outcome` is 'verified' only when an independent
   * check confirmed the work; anything self-reported is 'unverified'.
   */
  record({ tenantId, agentId = null, role = null, taskKind, taskId = null, outcome, costMicroUsd = 0, durationMs = 0, evidence = null, at = undefined }) {
    requireTenant(tenantId);
    if (!agentId && !role) throw new PerformanceError("INVALID_ARGUMENT", "An evaluation result needs an agentId or a role.");
    if (typeof taskKind !== "string" || !taskKind) throw new PerformanceError("INVALID_ARGUMENT", "'taskKind' is required.");
    if (!OUTCOMES.includes(outcome)) throw new PerformanceError("INVALID_OUTCOME", `outcome must be one of ${OUTCOMES.join(", ")}.`);
    nonNegativeInt(costMicroUsd, "costMicroUsd");
    nonNegativeInt(durationMs, "durationMs");
    const when = new Date(at ?? this.#clock());
    if (Number.isNaN(when.getTime())) throw new PerformanceError("INVALID_ARGUMENT", "'at' is not a valid time.");
    const row = {
      id: `evr_${randomUUID().replaceAll("-", "")}`,
      tenantId, agentId, role, taskKind, taskId, outcome, costMicroUsd, durationMs, evidence, at: when.toISOString(),
    };
    this.#db.prepare(`INSERT INTO evaluation_results (tenant_id, id, agent_id, role, task_kind, task_id, outcome, cost_micro_usd, duration_ms, evidence_json, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tenantId, row.id, agentId, role, taskKind, taskId, outcome, costMicroUsd, durationMs, evidence === null ? null : JSON.stringify(evidence), row.at);
    return row;
  }

  list(tenantId, { agentId, role, taskKind } = {}) {
    requireTenant(tenantId);
    const clauses = ["tenant_id = ?"];
    const params = [tenantId];
    if (agentId !== undefined) { clauses.push("agent_id = ?"); params.push(agentId); }
    if (role !== undefined) { clauses.push("role = ?"); params.push(role); }
    if (taskKind !== undefined) { clauses.push("task_kind = ?"); params.push(taskKind); }
    return this.#db.prepare(`SELECT * FROM evaluation_results WHERE ${clauses.join(" AND ")} ORDER BY seq`).all(...params).map((r) => ({
      id: r.id, tenantId: r.tenant_id, agentId: r.agent_id, role: r.role, taskKind: r.task_kind, taskId: r.task_id,
      outcome: r.outcome, costMicroUsd: r.cost_micro_usd, durationMs: r.duration_ms,
      evidence: r.evidence_json === null ? null : JSON.parse(r.evidence_json), at: r.at,
    }));
  }

  /**
   * Recency-weighted verified success for one agent (or one role) on one
   * task kind. Returns `score: null` with `sufficient: false` when there are
   * fewer than `minSamples` results.
   */
  score(tenantId, { agentId, role, taskKind, halfLifeMs = DEFAULT_HALF_LIFE_MS, minSamples = DEFAULT_MIN_SAMPLES, now = undefined } = {}) {
    if (agentId === undefined && role === undefined) throw new PerformanceError("INVALID_ARGUMENT", "score needs an agentId or a role.");
    if (!(halfLifeMs > 0)) throw new PerformanceError("INVALID_ARGUMENT", "halfLifeMs must be positive.");
    const reference = new Date(now ?? this.#clock()).getTime();
    const rows = this.list(tenantId, { ...(agentId !== undefined && { agentId }), ...(role !== undefined && { role }), ...(taskKind !== undefined && { taskKind }) });
    let weightSum = 0;
    let verifiedWeight = 0;
    let costWeighted = 0;
    let durationWeighted = 0;
    let verified = 0;
    for (const row of rows) {
      const age = Math.max(0, reference - Date.parse(row.at));
      const weight = 0.5 ** (age / halfLifeMs);
      weightSum += weight;
      costWeighted += weight * row.costMicroUsd;
      durationWeighted += weight * row.durationMs;
      if (row.outcome === "verified") { verified += 1; verifiedWeight += weight; }
    }
    const samples = rows.length;
    const sufficient = samples >= minSamples && weightSum > 0;
    const rate = weightSum > 0 ? verifiedWeight / weightSum : null;
    return {
      ...(agentId !== undefined && { agentId }),
      ...(role !== undefined && { role }),
      taskKind: taskKind ?? null,
      samples,
      verified,
      effectiveSamples: round(weightSum),
      sufficient,
      score: sufficient ? round(rate) : null,
      observedRate: rate === null ? null : round(rate),
      meanCostMicroUsd: weightSum > 0 ? Math.round(costWeighted / weightSum) : null,
      meanDurationMs: weightSum > 0 ? Math.round(durationWeighted / weightSum) : null,
    };
  }

  /** Scores several agents for one task kind, best first (insufficient data last). */
  rank(tenantId, agentIds, { taskKind, ...options } = {}) {
    return agentIds.map((agentId) => this.score(tenantId, { agentId, taskKind, ...options })).sort(compareScores);
  }
}

/** Sufficient scores first (higher is better), then cheaper, then id for determinism. */
export function compareScores(a, b) {
  if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1;
  if (a.sufficient && a.score !== b.score) return b.score - a.score;
  const ca = a.meanCostMicroUsd ?? Number.MAX_SAFE_INTEGER;
  const cb = b.meanCostMicroUsd ?? Number.MAX_SAFE_INTEGER;
  if (ca !== cb) return ca - cb;
  return String(a.agentId ?? a.role).localeCompare(String(b.agentId ?? b.role));
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
