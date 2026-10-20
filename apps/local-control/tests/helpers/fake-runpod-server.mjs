import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

/**
 * A local HTTP fake of the RunPod Serverless REST API (no network), driven by
 * a FakeClock. It implements the subset Atlas uses, as documented at
 * https://docs.runpod.io/serverless/endpoints/send-requests and
 * https://docs.runpod.io/serverless/endpoints/operation-reference:
 *
 *   POST /v2/{endpoint}/run          { input, policy: { executionTimeout, ttl } } -> { id, status: "IN_QUEUE" }
 *   GET  /v2/{endpoint}/status/{id}  -> { id, status, delayTime, executionTime?, workerId?, output?, error? }
 *   POST /v2/{endpoint}/cancel/{id}  -> { id, status }
 *
 * RunPod's own stops are modelled: a job is TIMED_OUT once it has executed
 * for `policy.executionTimeout` ms (default 600000), it is deleted (404) once
 * `policy.ttl` ms (default 24 h) have passed since submission, and a finished
 * job's result is kept for 30 minutes. Per-worker billing is modelled as
 * execution time + cold start + idle timeout, so tests can compare Atlas's
 * settled bill with what the fake "charged".
 *
 * Each job's behaviour comes from `input`: `durationMs` (default: never
 * finishes), `queueMs` (default 2000), `fail: true`, `output`.
 */
export const RESULT_RETENTION_MS = 30 * 60_000;

export async function startFakeRunpod({ clock, apiKey, endpointId = "atlas-test-endpoint", coldStartMs = 0, idleMs = 5_000 }) {
  const jobs = new Map();
  const requests = [];
  const faults = [];
  const hung = new Set();

  const view = (job) => {
    const now = clock.now();
    const ttl = job.policy.ttl ?? 86_400_000;
    const executionTimeout = job.policy.executionTimeout ?? 600_000;
    const startAt = job.submittedAt + (job.input.queueMs ?? 2_000);
    let status; let endAt = null;
    const started = (at) => at >= startAt;
    const finishAt = Number.isFinite(job.input.durationMs) && job.input.durationMs <= executionTimeout ? startAt + job.input.durationMs : null;
    const timeoutAt = startAt + executionTimeout;
    const ttlAt = job.submittedAt + ttl;
    const candidates = [
      job.cancelledAt !== null ? { at: job.cancelledAt, status: "CANCELLED" } : null,
      finishAt !== null ? { at: finishAt, status: job.input.fail ? "FAILED" : "COMPLETED" } : null,
      { at: timeoutAt, status: "TIMED_OUT" },
      { at: ttlAt, status: "TIMED_OUT" }, // a job past its ttl is stopped and deleted
    ].filter(Boolean).filter(candidate => candidate.at <= now).sort((a, b) => a.at - b.at);
    if (candidates.length) { status = candidates[0].status; endAt = candidates[0].at; } else status = started(now) ? "IN_PROGRESS" : "IN_QUEUE";
    const end = endAt ?? now;
    const ranMs = started(Math.min(end, ttlAt)) ? Math.min(end, ttlAt) - startAt : 0;
    return { status, endAt, startAt, ranMs, ran: started(Math.min(end, ttlAt)) && ranMs >= 0, deleted: now >= ttlAt || (endAt !== null && now >= endAt + RESULT_RETENTION_MS) };
  };

  const body = (job) => {
    const v = view(job);
    return {
      id: job.id, status: v.status, delayTime: Math.max(0, Math.min(clock.now(), v.startAt) - job.submittedAt),
      ...(v.ran ? { executionTime: v.ranMs, workerId: "fake-worker-1" } : {}),
      ...(v.status === "COMPLETED" ? { output: job.input.output ?? { ok: true } } : {}),
      ...(v.status === "FAILED" ? { error: "handler failed" } : {}),
    };
  };

  const send = (res, code, payload) => { res.writeHead(code, { "content-type": "application/json" }); res.end(typeof payload === "string" ? payload : JSON.stringify(payload)); };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const parsed = raw ? (() => { try { return JSON.parse(raw); } catch { return undefined; } })() : undefined;
      const record = { method: req.method, path: url.pathname, body: parsed, authorized: req.headers.authorization === `Bearer ${apiKey}` };
      requests.push(record);
      // A 401 that echoes the presented credential, as a careless API might: Atlas must not copy bodies into errors.
      if (!record.authorized) return send(res, 401, { error: `invalid api key ${req.headers.authorization ?? ""}` });
      const match = url.pathname.match(/^\/v2\/([^/]+)\/(run|status|cancel)(?:\/([^/]+))?$/u);
      if (!match || match[1] !== endpointId) return send(res, 404, { error: "not found" });
      const [, , op, id] = match;
      const fault = faults.findIndex(f => f.op === op);
      if (fault >= 0) {
        const [f] = faults.splice(fault, 1);
        if (f.createJob && op === "run") createJob(parsed);
        if (f.hang) { hung.add(res); return; }
        if (f.badJson) return send(res, 200, "{not json");
        return send(res, f.status, { error: `upstream failure ${f.status}` });
      }
      if (op === "run" && req.method === "POST") {
        const policy = parsed?.policy ?? {};
        for (const [key, min] of [["executionTimeout", 5_000], ["ttl", 10_000]]) {
          if (policy[key] !== undefined && (!Number.isInteger(policy[key]) || policy[key] < min || policy[key] > 7 * 86_400_000)) return send(res, 400, { error: `invalid ${key}` });
        }
        const job = createJob(parsed);
        return send(res, 200, { id: job.id, status: "IN_QUEUE" });
      }
      const job = jobs.get(id);
      if (!job || view(job).deleted) return send(res, 404, { error: "job not found" });
      if (op === "status" && req.method === "GET") return send(res, 200, body(job));
      if (op === "cancel" && req.method === "POST") {
        if (["IN_QUEUE", "IN_PROGRESS"].includes(view(job).status)) job.cancelledAt = clock.now();
        return send(res, 200, { id: job.id, status: view(job).status });
      }
      return send(res, 405, { error: "method not allowed" });
    });
  });

  function createJob(parsed) {
    const job = { id: `job-${randomUUID()}`, input: parsed?.input ?? {}, policy: parsed?.policy ?? {}, submittedAt: clock.now(), cancelledAt: null };
    jobs.set(job.id, job);
    return job;
  }

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v2`,
    endpointId,
    requests,
    jobs,
    /** Queue a fault for the next request of `op`: { status } | { hang } | { badJson }, optionally { createJob }. */
    fault(op, options) { faults.push({ op, ...options }); },
    /** Jobs RunPod would still run or bill (queued or executing). */
    running() { return [...jobs.values()].filter(job => ["IN_QUEUE", "IN_PROGRESS"].includes(view(job).status)); },
    statusOf(id) { const job = jobs.get(id); return job ? view(job).status : null; },
    /** What the fake "charged" for a job's worker time, in seconds (execution + cold start + idle), 0 if it never ran. */
    billedSeconds(id) { const v = view(jobs.get(id)); return v.ran ? Math.ceil((v.ranMs + coldStartMs + idleMs) / 1000) : 0; },
    async close() { for (const res of hung) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
