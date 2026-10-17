import { createHash, randomUUID } from "node:crypto";
import { validateTask } from "../tasks/dispatch.mjs";
import { classifyIntent } from "../../chat/intent.mjs";

export class MissionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const terminal = new Set(["completed", "failed", "stopped"]);
const scopeArgs = scope => {
  if (!Number.isSafeInteger(scope?.tenantId) || scope.tenantId < 1 || typeof scope.principal !== "string" || !scope.principal) throw new MissionError("A workspace scope is required.", 403);
  return [scope.tenantId, scope.principal];
};
function normalized(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MissionError("A mission plan is required.");
  if (!/^[0-9a-f-]{36}$/u.test(input.requestId ?? "")) throw new MissionError("A stable requestId UUID is required.");
  if (typeof input.objective !== "string" || !input.objective.trim() || input.objective.length > 4000) throw new MissionError("Provide a mission objective of at most 4000 characters.");
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 8) throw new MissionError("A mission requires 1-8 steps.");
  const seen = new Set();
  const steps = input.steps.map(step => {
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(step?.id ?? "") || seen.has(step.id)) throw new MissionError("Step ids must be unique short names.");
    if (!Array.isArray(step.dependencies) || new Set(step.dependencies).size !== step.dependencies.length || step.dependencies.some(id => !seen.has(id))) throw new MissionError("Each step must declare dependencies on earlier steps only.");
    const task = validateTask(step, new Set([String(step.repository ?? "").toLowerCase()]));
    if (task.error) throw new MissionError(task.error);
    if (classifyIntent(step.objective ?? "").kind === "new_project_task") throw new MissionError("New repositories use the separate project-creation workflow.");
    seen.add(step.id);
    return { id: step.id, dependencies: [...step.dependencies], ...task.task };
  });
  return { objective: input.objective.trim(), steps };
}

/** One CAS-updated record is the durable state machine; external dispatch is never retried. */
export class CloudMissions {
  constructor({ db, dispatch, receipt, outcome, now = () => Date.now() }) {
    Object.assign(this, { db, dispatch, receipt, outcome, now });
  }
  async get(scope, id) {
    const row = await this.db.prepare("SELECT revision, record_json FROM cloud_missions WHERE tenant_id=? AND requested_by=? AND id=?").bind(...scopeArgs(scope), id).first();
    return row ? { ...JSON.parse(row.record_json), revision: row.revision } : null;
  }
  async list(scope) { return (await this.listPage(scope)).missions; }
  async listPage(scope, cursor = null) {
    let boundary = null;
    if (cursor) {
      try {
        if (typeof cursor !== "string" || cursor.length > 500) throw new Error();
        boundary = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(boundary) || boundary.length !== 2 || typeof boundary[1] !== "string" || typeof boundary[0] !== "string" || new Date(boundary[0]).toISOString() !== boundary[0] || !/^[0-9a-f-]{36}$/u.test(boundary[1])) throw new Error();
      } catch { throw new MissionError("Invalid mission history cursor."); }
    }
    const query = "SELECT id,updated_at,revision,record_json FROM cloud_missions WHERE tenant_id=? AND requested_by=?"
      + (boundary ? " AND (updated_at<? OR (updated_at=? AND id>?))" : "")
      + " ORDER BY updated_at DESC,id LIMIT 31";
    const rows = await this.db.prepare(query).bind(...scopeArgs(scope), ...(boundary ? [boundary[0], boundary[0], boundary[1]] : [])).all();
    const page = rows.results.slice(0, 30);
    const last = page.at(-1);
    return { missions: page.map(row => { const record = JSON.parse(row.record_json); return { id: record.id, objective: record.objective.slice(0, 240), status: record.status, updatedAt: record.updatedAt, revision: row.revision }; }),
      nextCursor: rows.results.length > 30 ? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString("base64url") : null };
  }
  async create(scope, input) {
    const plan = normalized(input);
    const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const at = new Date(this.now()).toISOString();
    const mission = { id: input.requestId, digest, objective: plan.objective, status: "ready", dispatchLimit: plan.steps.length, dispatchCount: 0, createdAt: at, updatedAt: at,
      steps: plan.steps.map(step => ({ ...step, correlationId: `cor_${randomUUID().replaceAll("-", "")}`, state: "waiting", taskId: null, evidence: null, message: null })), events: [{ at, kind: "created" }] };
    await this.db.batch([
      this.db.prepare("INSERT INTO cloud_missions (tenant_id,requested_by,id,record_json,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(...scopeArgs(scope), mission.id, JSON.stringify(mission), at, at),
      this.db.prepare("INSERT INTO cloud_mission_events (tenant_id,requested_by,mission_id,revision,kind,status,created_at) SELECT tenant_id,requested_by,id,revision,'created','ready',created_at FROM cloud_missions WHERE tenant_id=? AND requested_by=? AND id=? AND revision=0 ON CONFLICT DO NOTHING")
        .bind(...scopeArgs(scope), mission.id),
    ]);
    const saved = await this.get(scope, mission.id);
    if (saved.digest !== digest) throw new MissionError("This requestId belongs to a different mission.", 409);
    return saved;
  }
  async save(scope, mission, kind) {
    const at = new Date(this.now()).toISOString();
    const { revision, ...record } = mission;
    record.updatedAt = at;
    record.events = [...record.events, { at, kind }].slice(-128);
    const [changed] = await this.db.batch([
      this.db.prepare("UPDATE cloud_missions SET record_json=?, revision=revision+1, updated_at=? WHERE tenant_id=? AND requested_by=? AND id=? AND revision=?")
        .bind(JSON.stringify(record), at, ...scopeArgs(scope), record.id, revision),
      this.db.prepare("INSERT INTO cloud_mission_events (tenant_id,requested_by,mission_id,revision,kind,status,created_at) SELECT tenant_id,requested_by,id,revision,?,?,? FROM cloud_missions WHERE tenant_id=? AND requested_by=? AND id=? AND revision=? ON CONFLICT DO NOTHING")
        .bind(kind, record.status, at, ...scopeArgs(scope), record.id, revision + 1),
    ]);
    return changed.meta.changes === 1;
  }
  async require(scope, id) {
    const mission = await this.get(scope, id);
    if (!mission) throw new MissionError("Mission not found.", 404);
    return mission;
  }
  async control(scope, id, action) {
    const mission = await this.require(scope, id);
    if (!["pause", "resume", "stop"].includes(action)) throw new MissionError("Unknown mission control.");
    if (terminal.has(mission.status)) throw new MissionError("This mission is terminal.", 409);
    mission.status = { pause: "paused", resume: "ready", stop: "stopped" }[action];
    if (!await this.save(scope, mission, action)) throw new MissionError("Mission changed; refresh and retry.", 409);
    return this.get(scope, id);
  }
  async advance(scope, id) {
    let mission = await this.require(scope, id);
    if (["completed", "failed"].includes(mission.status)) return mission;
    // Reconcile receipts before considering new work. A crash after external
    // acceptance can never turn an old dispatch intent back into a fresh one.
    for (const step of mission.steps) {
      if (["dispatching", "uncertain"].includes(step.state)) {
        const found = await this.receipt(scope, step.correlationId, step);
        if (found?.taskId) { step.taskId = found.taskId; step.state = "submitted"; step.message = null; }
        else if (step.state === "dispatching" && this.now() >= step.leaseUntil) { step.state = "uncertain"; step.message = "Dispatch outcome is uncertain. No retry was sent."; }
        else continue;
        if (!await this.save(scope, mission, "receipt-reconciled")) return this.get(scope, id);
        mission = await this.require(scope, id);
      }
      const current = mission.steps.find(item => item.id === step.id);
      if (current.state === "submitted") {
        const result = await this.outcome(scope, current.taskId, current);
        if (["completed", "failed"].includes(result?.status) && result.evidence) {
          current.state = result.status;
          current.evidence = result.evidence;
          if (!await this.save(scope, mission, "outcome-recorded")) return this.get(scope, id);
          mission = await this.require(scope, id);
        }
      }
    }
    if (terminal.has(mission.status) || mission.status === "paused") return mission;
    if (mission.steps.some(step => ["dispatching", "uncertain", "submitted"].includes(step.state))) return mission;
    if (mission.steps.some(step => step.state === "failed")) {
      mission.status = "failed";
      for (const step of mission.steps) if (step.state === "waiting") step.state = "blocked";
      await this.save(scope, mission, "failed");
      return this.get(scope, id);
    }
    if (mission.steps.every(step => step.state === "completed")) {
      mission.status = "completed";
      await this.save(scope, mission, "completed");
      return this.get(scope, id);
    }
    const next = mission.steps.find(step => step.state === "waiting" && step.dependencies.every(id => mission.steps.find(item => item.id === id).state === "completed"));
    if (!next || mission.dispatchCount >= mission.dispatchLimit) return mission;
    next.state = "dispatching";
    next.leaseUntil = this.now() + 60000;
    mission.status = "running";
    mission.dispatchCount++;
    if (!await this.save(scope, mission, "dispatch-intent")) return this.get(scope, id);
    let result;
    try { result = await this.dispatch(scope, next); }
    catch { result = { uncertain: true }; }
    // A pause/stop concurrent with dispatch must retain the receipt without
    // reactivating the mission or losing knowledge of externally started work.
    for (let attempt = 0; attempt < 5; attempt++) {
      const latest = await this.require(scope, id);
      const target = latest.steps.find(step => step.id === next.id);
      if (target.state !== "dispatching") return latest;
      if (result?.taskId && result.correlationId === next.correlationId) {
        target.taskId = result.taskId;
        target.state = "submitted";
      } else if (result?.rejected === true) {
        target.state = "failed";
        if (latest.status === "running") {
          latest.status = "failed";
          for (const step of latest.steps) if (step.state === "waiting") step.state = "blocked";
        }
        target.message = typeof result.message === "string" ? result.message.slice(0, 500) : "Task intake rejected this step. No automatic retry was sent.";
      } else {
        target.state = "uncertain";
        target.message = "Dispatch outcome is uncertain. No retry was sent.";
      }
      if (await this.save(scope, latest, "dispatch-recorded")) return this.get(scope, id);
    }
    throw new MissionError("Dispatch started; refresh to reconcile its receipt.", 409);
  }
}
