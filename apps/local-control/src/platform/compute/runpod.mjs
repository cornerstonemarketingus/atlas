import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ComputeProviderError, microUsdPerSecond } from "./provider.mjs";

/**
 * RunPod Serverless as an Atlas compute provider (issue #353, decision D4).
 *
 * The provider interface talks about "instances"; on RunPod Serverless an
 * instance is one job submitted to a pre-configured endpoint
 * (ATLAS_RUNPOD_ENDPOINT_ID). RunPod starts a worker for the job and scales
 * the endpoint back to zero when the queue is empty, so a job is the unit
 * that bills.
 *
 * API used (REST, `https://api.runpod.ai/v2/{endpoint_id}/...`, header
 * `Authorization: Bearer <key>`):
 *   POST /run              { input, policy: { executionTimeout, ttl } } -> { id, status }
 *   GET  /status/{job_id}  -> { id, status, delayTime?, executionTime?, workerId?, output?, error? }
 *   POST /cancel/{job_id}  -> { id, status: "CANCELLED" }
 * Sources (read 2026-10-19):
 *   https://docs.runpod.io/serverless/endpoints/send-requests       (policy: executionTimeout and ttl in ms,
 *       executionTimeout default 600000, min 5 s, max 7 days; ttl default 24 h, min 10 s, max 7 days;
 *       ttl covers queue + execution, a job past its ttl is deleted and /status returns 404)
 *   https://docs.runpod.io/serverless/endpoints/operation-reference (/run, /status, /cancel, /health, /purge-queue;
 *       /run results are kept for 30 minutes; cancel stops in-progress jobs and removes queued ones)
 *   https://docs.runpod.io/serverless/references/job-states         (IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED,
 *       CANCELLED, TIMED_OUT; delayTime and executionTime are milliseconds)
 *   https://docs.runpod.io/serverless/endpoints/endpoint-configurations (worker idle timeout default 5 s and billed;
 *       GPU pools AMPERE_16, AMPERE_24, ADA_24, AMPERE_48, ADA_48_PRO, AMPERE_80, ADA_80_PRO)
 *   https://docs.runpod.io/serverless/pricing                       (per-second flex billing from worker start to
 *       stop, rounded up to the second)
 *
 * How the four stops map onto RunPod:
 *  - Provider-side max lifetime: every job is submitted with
 *    `policy.executionTimeout` = maxLifetimeSec minus the billing overhead
 *    (worker idle timeout + a cold-start allowance) and `policy.ttl` =
 *    executionTimeout + a queue allowance. RunPod itself stops the job, so a
 *    crashed Atlas still stops billing.
 *  - Tags: RunPod jobs carry no tags or metadata and there is no "list jobs"
 *    API, so Atlas keeps a journal (`runpod_jobs`, node:sqlite, normally the
 *    lease database file). The journal row is written BEFORE /run is called,
 *    and `listTagged` answers from it, refreshing each job with /status. A
 *    row whose /run outcome is unknown (crash mid-request, network timeout,
 *    5xx) is reported as an `unconfirmed:` instance whose bill is unknown, so
 *    the manager keeps that lease's full reservation instead of trusting it
 *    cost nothing. RunPod's own executionTimeout/ttl bound such a job.
 *  - Billing: RunPod bills workers, not jobs, and exposes no per-job cost.
 *    A job's bill is computed as (ceil(executionTime) + billing overhead) x
 *    the configured per-second rate, and while the execution time is not
 *    known, as the elapsed time since submission plus the idle timeout,
 *    capped at maxLifetimeSec (RunPod cannot run it longer). A bill that
 *    cannot be derived is null and settles as the full reservation.
 *
 * The API key comes from the credential vault or ATLAS_RUNPOD_API_KEY through
 * the `apiKey` resolver. It is kept in a private field, sent only in the
 * Authorization header to the configured https base URL, and never put in
 * an error, a log line, the journal or a returned object. Errors carry an
 * HTTP status code and the operation name, never a response body.
 */

/** Where the default prices come from. Override them with `pricing` (ATLAS_RUNPOD_PRICING). */
export const RUNPOD_PRICING_SOURCE = Object.freeze({
  url: "https://docs.runpod.io/serverless/pricing",
  alsoSeen: "https://www.runpod.io/product/serverless",
  retrieved: "2026-10-19",
  note: "Serverless flex (scale-to-zero) per-hour equivalents. Where sources disagreed the higher price is used, so reservations err high.",
});

/** Flex-worker prices per GPU pool (USD per hour), from RUNPOD_PRICING_SOURCE. */
export const RUNPOD_DEFAULT_PRICING = Object.freeze([
  Object.freeze({ gpuType: "AMPERE_16", vramGb: 16, hourlyUsd: 0.58, examples: "A4000, A4500, RTX 4000" }),
  Object.freeze({ gpuType: "AMPERE_24", vramGb: 24, hourlyUsd: 0.68, examples: "L4, A5000, RTX 3090" }),
  Object.freeze({ gpuType: "ADA_24", vramGb: 24, hourlyUsd: 1.12, examples: "RTX 4090" }),
  Object.freeze({ gpuType: "AMPERE_48", vramGb: 48, hourlyUsd: 1.22, examples: "A6000, A40" }),
  Object.freeze({ gpuType: "ADA_48_PRO", vramGb: 48, hourlyUsd: 1.91, examples: "L40, L40S, RTX 6000 Ada" }),
  Object.freeze({ gpuType: "AMPERE_80", vramGb: 80, hourlyUsd: 2.74, examples: "A100 80GB" }),
  Object.freeze({ gpuType: "ADA_80_PRO", vramGb: 80, hourlyUsd: 4.79, examples: "H100 80GB" }),
]);

export const RUNPOD_DEFAULT_BASE_URL = "https://api.runpod.ai/v2";
export const RUNPOD_MIN_EXECUTION_TIMEOUT_MS = 5_000;
export const RUNPOD_MIN_TTL_MS = 10_000;
export const RUNPOD_MAX_POLICY_MS = 7 * 24 * 3600 * 1000;
const TERMINAL = Object.freeze(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);
const LIVE = Object.freeze(["IN_QUEUE", "IN_PROGRESS"]);
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const ENDPOINT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const POOL_ID = /^[A-Z0-9_]{2,32}$/u;
const UNCONFIRMED = "unconfirmed:";
const REASONS = Object.freeze({ COMPLETED: "completed", FAILED: "failed", CANCELLED: "requested", TIMED_OUT: "max_lifetime" });

/**
 * Merges price overrides into the default table. `overrides` is
 * `{ POOL: hourlyUsd | { hourlyUsd, vramGb } }` or a list of
 * `{ gpuType, vramGb, hourlyUsd }`; a new pool needs its vramGb.
 */
export function resolveRunpodPricing(overrides = undefined) {
  const table = new Map(RUNPOD_DEFAULT_PRICING.map(entry => [entry.gpuType, { ...entry }]));
  if (overrides === undefined || overrides === null) return table;
  const entries = Array.isArray(overrides)
    ? overrides.map(entry => [entry?.gpuType, entry])
    : Object.entries(overrides).map(([gpuType, value]) => [gpuType, typeof value === "number" ? { hourlyUsd: value } : value]);
  for (const [gpuType, value] of entries) {
    if (!POOL_ID.test(String(gpuType))) throw new ComputeProviderError("INVALID_PRICING", "RunPod pricing keys must be GPU pool ids such as ADA_24.");
    const base = table.get(gpuType) ?? {};
    const entry = { ...base, gpuType, ...(value ?? {}) };
    if (!Number.isFinite(entry.hourlyUsd) || entry.hourlyUsd <= 0) throw new ComputeProviderError("INVALID_PRICING", `RunPod price for ${gpuType} must be a positive hourly USD amount.`);
    if (!Number.isFinite(entry.vramGb) || entry.vramGb <= 0) throw new ComputeProviderError("INVALID_PRICING", `RunPod pool ${gpuType} needs its vramGb.`);
    table.set(gpuType, entry);
  }
  return table;
}

function checkBaseUrl(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new ComputeProviderError("INVALID_CONFIG", "The RunPod base URL is not a URL."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  // The API key is a bearer token: it only ever travels over TLS (plain http is allowed for a loopback test server).
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new ComputeProviderError("INVALID_CONFIG", "The RunPod base URL must use https.");
  if (url.username || url.password || url.search || url.hash) throw new ComputeProviderError("INVALID_CONFIG", "The RunPod base URL must be a plain origin and path.");
  return url.href.replace(/\/+$/u, "");
}

const positiveInt = (value, name, { allowZero = false } = {}) => {
  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) throw new ComputeProviderError("INVALID_CONFIG", `${name} must be a ${allowZero ? "non-negative" : "positive"} integer.`);
  return value;
};

export class RunpodProvider {
  #endpointId;
  #apiKey;
  #baseUrl;
  #fetch;
  #now;
  #db;
  #gpuTypes;
  #pools;
  #hourlyUsd;
  #rate;
  #idleSec;
  #coldStartSec;
  #queueTtlSec;
  #requestTimeoutMs;
  #outputs = new Map();
  #ownsDb = false;

  /**
   * @param options.endpointId   the RunPod Serverless endpoint that runs Atlas's worker image
   * @param options.apiKey       the key, or `async () => key | null` (vault first, then env)
   * @param options.gpuTypes     the GPU pools the endpoint is configured with; a job may land on any of them
   * @param options.pricing      price overrides (see resolveRunpodPricing)
   * @param options.workerIdleTimeoutSec  the endpoint's idle timeout (billed after every job; RunPod default 5)
   * @param options.coldStartAllowanceSec worker boot time budgeted per job (billed, not bounded by executionTimeout)
   * @param options.queueTtlSec  how long a job may wait for a worker before RunPod drops it unbilled
   * @param options.db           filename or DatabaseSync for the job journal (use the lease database)
   */
  constructor({
    name = "runpod", endpointId, apiKey, baseUrl = RUNPOD_DEFAULT_BASE_URL, gpuTypes = ["AMPERE_24"], pricing = undefined,
    workerIdleTimeoutSec = 5, coldStartAllowanceSec = 60, queueTtlSec = 900, requestTimeoutMs = 15_000,
    db = ":memory:", clock = () => Date.now(), fetchImpl = globalThis.fetch,
  } = {}) {
    if (!ENDPOINT_ID.test(String(endpointId ?? ""))) throw new ComputeProviderError("INVALID_CONFIG", "A RunPod endpoint id is required (ATLAS_RUNPOD_ENDPOINT_ID).");
    if (typeof apiKey !== "string" && typeof apiKey !== "function") throw new ComputeProviderError("INVALID_CONFIG", "A RunPod API key or key resolver is required.");
    if (typeof fetchImpl !== "function") throw new ComputeProviderError("INVALID_CONFIG", "RunpodProvider needs fetch.");
    this.name = name;
    this.#endpointId = endpointId;
    this.#apiKey = apiKey;
    this.#baseUrl = checkBaseUrl(baseUrl);
    this.#fetch = fetchImpl;
    this.#now = typeof clock === "function" ? clock : () => clock.now();
    const table = resolveRunpodPricing(pricing);
    if (!Array.isArray(gpuTypes) || !gpuTypes.length) throw new ComputeProviderError("INVALID_CONFIG", "At least one RunPod GPU pool is required.");
    this.#pools = gpuTypes.map(gpuType => {
      const entry = table.get(gpuType);
      if (!entry) throw new ComputeProviderError("INVALID_CONFIG", `No price is known for RunPod GPU pool '${gpuType}'; add it to the pricing table.`);
      return entry;
    });
    this.#gpuTypes = gpuTypes.join("|");
    // A job may land on any configured pool: reserve at the most expensive.
    this.#hourlyUsd = Math.max(...this.#pools.map(pool => pool.hourlyUsd));
    this.#rate = microUsdPerSecond(this.#hourlyUsd);
    this.#idleSec = positiveInt(workerIdleTimeoutSec, "workerIdleTimeoutSec", { allowZero: true });
    this.#coldStartSec = positiveInt(coldStartAllowanceSec, "coldStartAllowanceSec", { allowZero: true });
    this.#queueTtlSec = positiveInt(queueTtlSec, "queueTtlSec");
    this.#requestTimeoutMs = positiveInt(requestTimeoutMs, "requestTimeoutMs");
    this.#ownsDb = typeof db === "string";
    this.#db = this.#ownsDb ? new DatabaseSync(db) : db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runpod_jobs (
        local_id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, job_id TEXT UNIQUE, state TEXT NOT NULL, tags_json TEXT NOT NULL,
        gpu_type TEXT NOT NULL, rate_micro_usd_per_sec INTEGER NOT NULL, max_lifetime_sec INTEGER NOT NULL,
        execution_timeout_ms INTEGER NOT NULL, ttl_ms INTEGER NOT NULL, overhead_sec INTEGER NOT NULL, idle_sec INTEGER NOT NULL,
        submitted_at INTEGER NOT NULL, runpod_status TEXT, execution_ms INTEGER, ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS runpod_jobs_state ON runpod_jobs (state);
    `);
  }

  /** Closes the journal if this provider opened it (an open SQLite handle locks the file on Windows). */
  close() {
    if (!this.#ownsDb) return;
    this.#ownsDb = false; // idempotent on every Node version (isOpen is not in all 22.x releases)
    this.#db.close();
  }

  /** Seconds billed around each job's execution: worker idle timeout plus the cold-start allowance. */
  get billingOverheadSec() { return this.#idleSec + this.#coldStartSec; }
  /** The smallest maxLifetimeSec this provider can honour. */
  get minLifetimeSec() { return this.billingOverheadSec + RUNPOD_MIN_EXECUTION_TIMEOUT_MS / 1000; }
  get rateMicroUsdPerSec() { return this.#rate; }

  async estimate(job) {
    const minVram = job?.minVramGb ?? 0;
    // Every pool the endpoint may use must fit the job.
    if (Math.min(...this.#pools.map(pool => pool.vramGb)) < minVram) return null;
    const runMinutes = Math.max(1, Math.ceil(job?.estMinutes ?? 10));
    return { gpuType: this.#gpuTypes, estHourlyUsd: this.#hourlyUsd, estMinutes: runMinutes + Math.ceil(this.billingOverheadSec / 60) };
  }

  async provision({ gpuType, maxLifetimeSec, tags = [], input = {} }) {
    if (gpuType !== this.#gpuTypes) throw new ComputeProviderError("UNKNOWN_GPU", `This RunPod endpoint runs '${this.#gpuTypes}', not '${gpuType}'.`);
    if (!Number.isInteger(maxLifetimeSec) || maxLifetimeSec <= 0) throw new ComputeProviderError("INVALID_ARGUMENT", "maxLifetimeSec must be a positive integer.");
    const executionTimeout = Math.min(RUNPOD_MAX_POLICY_MS, (maxLifetimeSec - this.billingOverheadSec) * 1000);
    if (executionTimeout < RUNPOD_MIN_EXECUTION_TIMEOUT_MS) {
      throw new ComputeProviderError("LIFETIME_TOO_SHORT", `RunPod jobs need a max lifetime of at least ${this.minLifetimeSec} s (cold start, idle timeout and RunPod's 5 s minimum).`);
    }
    const ttl = Math.min(RUNPOD_MAX_POLICY_MS, Math.max(RUNPOD_MIN_TTL_MS, executionTimeout + this.#queueTtlSec * 1000));
    const localId = randomUUID();
    // Journal first: if Atlas dies mid-request, this row still marks a job that may exist.
    this.#db.prepare(`INSERT INTO runpod_jobs (local_id, endpoint_id, job_id, state, tags_json, gpu_type, rate_micro_usd_per_sec, max_lifetime_sec,
      execution_timeout_ms, ttl_ms, overhead_sec, idle_sec, submitted_at) VALUES (?, ?, NULL, 'submitting', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(localId, this.#endpointId, JSON.stringify(tags.map(String)), this.#gpuTypes, this.#rate, maxLifetimeSec, executionTimeout, ttl,
        this.billingOverheadSec, this.#idleSec, this.#now());
    let body;
    try {
      body = await this.#request("POST", "/run", "run", { input: input ?? {}, policy: { executionTimeout, ttl } });
    } catch (error) {
      // A 4xx is a definite refusal; anything else may have created a job we cannot see.
      if (/^RUNPOD_HTTP_4\d\d$/u.test(error.code)) this.#setRow(localId, { state: "rejected", ended_at: this.#now() });
      throw error;
    }
    if (!JOB_ID.test(String(body?.id ?? ""))) throw new ComputeProviderError("RUNPOD_BAD_RESPONSE", "RunPod /run returned no usable job id.");
    this.#setRow(localId, { job_id: body.id, state: "submitted", runpod_status: LIVE.includes(body.status) ? body.status : "IN_QUEUE" });
    return this.#view(this.#row(localId));
  }

  async status(instanceId) {
    const row = this.#find(instanceId);
    if (!row) return null;
    if (row.state !== "submitted") return this.#view(row);
    return this.#view(await this.#refresh(row));
  }

  async terminate(instanceId) {
    let row = this.#find(instanceId);
    if (!row) return null;
    if (row.state === "submitting") {
      // Its job id is unknown, so it cannot be cancelled; RunPod's executionTimeout/ttl bound it.
      this.#setRow(row.local_id, { state: "abandoned", ended_at: this.#now() });
      return this.#view(this.#row(row.local_id));
    }
    if (row.state !== "submitted") return this.#view(row);
    const cancelled = await this.#request("POST", `/cancel/${encodeURIComponent(row.job_id)}`, "cancel", undefined, { allow404: true });
    if (cancelled === null) return this.#view(this.#expire(row));
    // Read the final status for its executionTime; fall back to the cancel answer.
    row = await this.#refresh(this.#row(row.local_id)).catch(() => this.#apply(this.#row(row.local_id), cancelled));
    return this.#view(row);
  }

  async listTagged(tag) {
    const rows = this.#db.prepare("SELECT * FROM runpod_jobs WHERE endpoint_id = ? AND state IN ('submitting', 'submitted') ORDER BY submitted_at")
      .all(this.#endpointId).filter(row => JSON.parse(row.tags_json).includes(tag));
    const out = [];
    for (let row of rows) {
      if (row.state === "submitted") {
        // A failed status read keeps the job listed as running: listing errs toward cancelling.
        try { row = await this.#refresh(row); } catch { /* keep last known */ }
      }
      const view = this.#view(row);
      if (view.state === "running") out.push(view);
    }
    return out;
  }

  /**
   * Polls a job until RunPod reports it finished, calling `heartbeat()` after
   * each poll so the manager's idle stop sees a live job. Resolves with the
   * worker's output on COMPLETED; rejects with RUNPOD_JOB_<STATUS> otherwise,
   * or when `signal` aborts.
   */
  async waitForCompletion(instanceId, { signal = undefined, heartbeat = () => true, pollIntervalMs = 2_000, sleep = defaultSleep } = {}) {
    for (;;) {
      if (signal?.aborted) throw new ComputeProviderError("RUNPOD_JOB_ABORTED", "The lease ended while waiting for the RunPod job.");
      const view = await this.status(instanceId);
      if (!view) throw new ComputeProviderError("RUNPOD_JOB_UNKNOWN", "The RunPod job is not in the journal.");
      heartbeat();
      if (view.state === "terminated") {
        if (view.runpodStatus === "COMPLETED") return this.#outputs.get(instanceId);
        throw new ComputeProviderError(`RUNPOD_JOB_${view.runpodStatus ?? "LOST"}`, `The RunPod job ended as ${view.runpodStatus ?? "unknown"}.`);
      }
      await sleep(pollIntervalMs, signal);
    }
  }

  // ---------------------------------------------------------------------------

  async #resolveKey() {
    let key = null;
    try { key = typeof this.#apiKey === "function" ? await this.#apiKey() : this.#apiKey; } catch { key = null; }
    if (typeof key !== "string" || !key.trim()) throw new ComputeProviderError("RUNPOD_NO_API_KEY", "No RunPod API key is configured (vault or ATLAS_RUNPOD_API_KEY).");
    return key.trim();
  }

  /** One API call. Never copies the key or a response body into an error. Returns null for an allowed 404. */
  async #request(method, path, operation, body = undefined, { allow404 = false } = {}) {
    const key = await this.#resolveKey();
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/${encodeURIComponent(this.#endpointId)}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(this.#requestTimeoutMs),
        headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ComputeProviderError("RUNPOD_UNREACHABLE", `RunPod ${operation} request failed before a response.`);
    }
    if (allow404 && response.status === 404) { await response.body?.cancel?.().catch(() => {}); return null; }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new ComputeProviderError(`RUNPOD_HTTP_${response.status}`, `RunPod ${operation} returned HTTP ${response.status}.`);
    }
    try { return await response.json(); } catch { throw new ComputeProviderError("RUNPOD_BAD_RESPONSE", `RunPod ${operation} returned invalid JSON.`); }
  }

  async #refresh(row) {
    const body = await this.#request("GET", `/status/${encodeURIComponent(row.job_id)}`, "status", undefined, { allow404: true });
    return body === null ? this.#expire(row) : this.#apply(row, body);
  }

  /** Records a status answer: the latest status, execution time once known, and when it ended. */
  #apply(row, body) {
    const status = [...LIVE, ...TERMINAL].includes(body?.status) ? body.status : row.runpod_status;
    const fields = { runpod_status: status };
    if (Number.isFinite(body?.executionTime) && body.executionTime >= 0) fields.execution_ms = Math.ceil(body.executionTime);
    if (TERMINAL.includes(status)) {
      fields.state = "terminal"; fields.ended_at = row.ended_at ?? this.#now();
      if (status === "COMPLETED" && body.output !== undefined) this.#outputs.set(row.job_id, body.output);
    }
    this.#setRow(row.local_id, fields);
    return this.#row(row.local_id);
  }

  /** RunPod no longer knows the job (past its ttl, or results expired): it cannot bill any more, but its bill is unproven. */
  #expire(row) {
    this.#setRow(row.local_id, { state: "expired", ended_at: row.ended_at ?? this.#now() });
    return this.#row(row.local_id);
  }

  #find(instanceId) {
    const id = String(instanceId ?? "");
    if (id.startsWith(UNCONFIRMED)) return this.#row(id.slice(UNCONFIRMED.length));
    if (!JOB_ID.test(id)) return null;
    return this.#db.prepare("SELECT * FROM runpod_jobs WHERE job_id = ?").get(id) ?? null;
  }

  #row(localId) { return this.#db.prepare("SELECT * FROM runpod_jobs WHERE local_id = ?").get(localId) ?? null; }

  #setRow(localId, fields) {
    const keys = Object.keys(fields);
    this.#db.prepare(`UPDATE runpod_jobs SET ${keys.map(key => `${key} = ?`).join(", ")} WHERE local_id = ?`).run(...keys.map(key => fields[key]), localId);
  }

  /**
   * The provider-interface view of a journal row. `billedMicroUsd` is derived
   * (see the module comment); null means unprovable, which the manager
   * settles as the full reservation.
   */
  #view(row) {
    const tags = JSON.parse(row.tags_json);
    const id = row.job_id ?? `${UNCONFIRMED}${row.local_id}`;
    const elapsedBound = (end) => Math.min(row.max_lifetime_sec, Math.ceil(Math.max(0, end - row.submitted_at) / 1000) + row.idle_sec) * row.rate_micro_usd_per_sec;
    const base = { id, gpuType: row.gpu_type, tags, runpodStatus: row.runpod_status ?? null };
    switch (row.state) {
      case "submitting":
        return { ...base, state: "running", billedMicroUsd: null, unconfirmed: true };
      case "submitted":
        return { ...base, state: "running", billedMicroUsd: elapsedBound(this.#now()) };
      case "rejected":
        return { ...base, state: "terminated", billedMicroUsd: 0, terminationReason: "rejected" };
      case "abandoned":
        return { ...base, state: "terminated", billedMicroUsd: null, terminationReason: "unconfirmed", unconfirmed: true };
      case "expired":
        return { ...base, state: "terminated", billedMicroUsd: null, terminationReason: "expired" };
      default: {
        const billed = row.execution_ms !== null
          ? (Math.ceil(row.execution_ms / 1000) + row.overhead_sec) * row.rate_micro_usd_per_sec
          : elapsedBound(row.ended_at);
        return { ...base, state: "terminated", billedMicroUsd: billed, terminationReason: REASONS[row.runpod_status] ?? "ended" };
      }
    }
  }
}

function defaultSleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
