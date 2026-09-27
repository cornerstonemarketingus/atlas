import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ACTIVE_STATES, HOLD_STATES, assertTransition } from "./lifecycle.mjs";

/**
 * Durable Project Genesis state on this machine.
 *
 * A project row holds the current lifecycle state, the structured
 * specification, the plan and the workspace/preview references. Every state
 * change is appended to `genesis_transitions` in the same transaction as the
 * change, with its reason and evidence, so progress is never just UI state
 * and a restart never loses where a project was. Implementation tasks are
 * rows too (status, attempts, evidence), because the build/repair loop
 * reports on each one.
 *
 * Execution machinery (coder runs, checks, previews, approvals) is not kept
 * here; those subsystems keep their own records and Genesis stores
 * references to them as evidence.
 */

export class GenesisStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GenesisStoreError";
    this.code = code;
  }
}

const json = (value) => JSON.stringify(value ?? null);
const parse = (text, fallback = null) => { try { return text === null || text === undefined ? fallback : JSON.parse(text); } catch { return fallback; } };
const MAX_EVIDENCE = 64_000;

function boundedEvidence(evidence) {
  const text = json(evidence ?? {});
  return text.length <= MAX_EVIDENCE ? text : json({ truncated: true, preview: text.slice(0, MAX_EVIDENCE - 200) });
}

export const TASK_STATES = Object.freeze(["pending", "running", "passed", "failed", "skipped", "blocked"]);

export class GenesisStore {
  #db;
  #now;

  constructor(filename = ":memory:", { now = () => new Date() } = {}) {
    this.#db = new DatabaseSync(filename);
    this.#now = now;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS genesis_projects (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL,
        resume_to TEXT,
        spec_json TEXT,
        plan_json TEXT,
        workspace TEXT,
        preview_json TEXT,
        repair_budget INTEGER NOT NULL DEFAULT 3,
        repairs_used INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS genesis_projects_tenant_idx ON genesis_projects(tenant_id, updated_at);
      CREATE TABLE IF NOT EXISTS genesis_transitions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES genesis_projects(id),
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        actor TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS genesis_transitions_project_idx ON genesis_transitions(project_id, seq);
      CREATE TABLE IF NOT EXISTS genesis_tasks (
        project_id TEXT NOT NULL REFERENCES genesis_projects(id),
        task_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        executor TEXT NOT NULL DEFAULT 'template',
        objective TEXT NOT NULL,
        inputs_json TEXT NOT NULL,
        outputs_json TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, task_id)
      );
    `);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS genesis_publish_requests (
        approval_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES genesis_projects(id),
        remote TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Publish requests of other kinds (repository creation, deployment) carry their approved plan.
    for (const column of ["kind TEXT NOT NULL DEFAULT 'push'", "plan_json TEXT"]) {
      try { this.#db.exec(`ALTER TABLE genesis_publish_requests ADD COLUMN ${column}`); } catch { /* already present */ }
    }
    // Additive migration for databases created before tasks recorded their executor.
    try { this.#db.exec("ALTER TABLE genesis_tasks ADD COLUMN executor TEXT NOT NULL DEFAULT 'template'"); } catch { /* already present */ }
  }

  close() { this.#db.close(); }

  #stamp() { return this.#now().toISOString(); }

  #tx(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #row(tenantId, id) {
    const row = this.#db.prepare("SELECT * FROM genesis_projects WHERE id = ? AND tenant_id = ?").get(id, tenantId);
    if (!row) throw new GenesisStoreError("NOT_FOUND", "No Genesis project with that id.");
    return row;
  }

  #project(row) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      prompt: row.prompt,
      state: row.state,
      resumeTo: row.resume_to,
      spec: parse(row.spec_json),
      plan: parse(row.plan_json),
      workspace: row.workspace,
      preview: parse(row.preview_json),
      repairBudget: row.repair_budget,
      repairsUsed: row.repairs_used,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  create({ tenantId, prompt, name, actor = "owner", repairBudget = 3 }) {
    const id = `gen_${randomUUID()}`;
    const at = this.#stamp();
    return this.#tx(() => {
      this.#db.prepare("INSERT INTO genesis_projects (id, tenant_id, name, prompt, state, repair_budget, created_at, updated_at) VALUES (?, ?, ?, ?, 'idea', ?, ?, ?)")
        .run(id, tenantId, name, prompt, repairBudget, at, at);
      this.#db.prepare("INSERT INTO genesis_transitions (project_id, from_state, to_state, reason, evidence_json, actor, at) VALUES (?, NULL, 'idea', ?, ?, ?, ?)")
        .run(id, "The owner described what to build.", boundedEvidence({ kind: "request", prompt }), actor, at);
      return this.get(tenantId, id);
    });
  }

  get(tenantId, id) { return this.#project(this.#row(tenantId, id)); }

  list(tenantId, { limit = 50 } = {}) {
    return this.#db.prepare("SELECT * FROM genesis_projects WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?").all(tenantId, limit).map((row) => this.#project(row));
  }

  /**
   * Moves a project to `to`, atomically with its transition record. Pass
   * `expectedVersion` to refuse a stale write (two workers racing).
   * `patch` updates spec/plan/workspace/preview/repairsUsed in the same step.
   */
  transition(tenantId, id, to, { reason, evidence = {}, actor = "atlas", expectedVersion = undefined, patch = {} }) {
    if (typeof reason !== "string" || !reason.trim()) throw new GenesisStoreError("REASON_REQUIRED", "Every transition needs a reason.");
    return this.#tx(() => {
      const row = this.#row(tenantId, id);
      if (expectedVersion !== undefined && row.version !== expectedVersion) throw new GenesisStoreError("STALE_VERSION", "The project changed since it was read.");
      assertTransition(row.state, to, { resumeTo: row.resume_to });
      const at = this.#stamp();
      // Entering a hold remembers where to come back to; leaving one clears it.
      const resumeTo = HOLD_STATES.includes(to) ? (HOLD_STATES.includes(row.state) ? row.resume_to : row.state) : null;
      const fields = { state: to, resume_to: resumeTo, updated_at: at, version: row.version + 1 };
      if ("spec" in patch) fields.spec_json = json(patch.spec);
      if ("plan" in patch) fields.plan_json = json(patch.plan);
      if ("workspace" in patch) fields.workspace = patch.workspace;
      if ("preview" in patch) fields.preview_json = json(patch.preview);
      if ("name" in patch) fields.name = String(patch.name).slice(0, 120);
      if ("repairsUsed" in patch) fields.repairs_used = patch.repairsUsed;
      const names = Object.keys(fields);
      this.#db.prepare(`UPDATE genesis_projects SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE id = ?`).run(...names.map((name) => fields[name]), id);
      this.#db.prepare("INSERT INTO genesis_transitions (project_id, from_state, to_state, reason, evidence_json, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, row.state, to, reason.slice(0, 1000), boundedEvidence(evidence), actor, at);
      return this.get(tenantId, id);
    });
  }

  transitions(tenantId, id) {
    this.#row(tenantId, id);
    return this.#db.prepare("SELECT * FROM genesis_transitions WHERE project_id = ? ORDER BY seq").all(id).map((row) => ({
      seq: row.seq, from: row.from_state, to: row.to_state, reason: row.reason, evidence: parse(row.evidence_json, {}), actor: row.actor, at: row.at,
    }));
  }

  /** Replaces the project's task list (a new plan); existing evidence for re-planned tasks is dropped with them. */
  replaceTasks(tenantId, id, tasks) {
    this.#row(tenantId, id);
    const at = this.#stamp();
    this.#tx(() => {
      this.#db.prepare("DELETE FROM genesis_tasks WHERE project_id = ?").run(id);
      const insert = this.#db.prepare("INSERT INTO genesis_tasks (project_id, task_id, position, title, kind, executor, objective, inputs_json, outputs_json, depends_on_json, verification_json, status, attempts, evidence_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?)");
      tasks.forEach((task, index) => insert.run(id, task.id, index, task.title, task.kind, task.executor ?? "template", task.objective, json(task.inputs ?? []), json(task.outputs ?? []), json(task.dependsOn ?? []), json(task.verification ?? []), task.status ?? "pending", at));
    });
    return this.tasks(tenantId, id);
  }

  tasks(tenantId, id) {
    this.#row(tenantId, id);
    return this.#db.prepare("SELECT * FROM genesis_tasks WHERE project_id = ? ORDER BY position").all(id).map((row) => ({
      id: row.task_id, title: row.title, kind: row.kind, executor: row.executor, objective: row.objective,
      inputs: parse(row.inputs_json, []), outputs: parse(row.outputs_json, []), dependsOn: parse(row.depends_on_json, []),
      verification: parse(row.verification_json, []), status: row.status, attempts: row.attempts, evidence: parse(row.evidence_json, []), updatedAt: row.updated_at,
    }));
  }

  /** Records progress on one task; each call appends evidence (bounded to the latest 20 entries). */
  updateTask(tenantId, id, taskId, { status, attempt = false, evidence = null }) {
    if (status !== undefined && !TASK_STATES.includes(status)) throw new GenesisStoreError("INVALID_TASK_STATE", `Unknown task state ${status}.`);
    this.#row(tenantId, id);
    return this.#tx(() => {
      const row = this.#db.prepare("SELECT * FROM genesis_tasks WHERE project_id = ? AND task_id = ?").get(id, taskId);
      if (!row) throw new GenesisStoreError("NOT_FOUND", "No task with that id in this project.");
      const list = parse(row.evidence_json, []);
      if (evidence) list.push({ at: this.#stamp(), ...evidence });
      this.#db.prepare("UPDATE genesis_tasks SET status = ?, attempts = ?, evidence_json = ?, updated_at = ? WHERE project_id = ? AND task_id = ?")
        .run(status ?? row.status, row.attempts + (attempt ? 1 : 0), boundedEvidence(list.slice(-20)), this.#stamp(), id, taskId);
      return this.tasks(tenantId, id).find((task) => task.id === taskId);
    });
  }

  /** A publish waiting for the owner's approval; survives restarts. */
  recordPublishRequest(projectId, { approvalId, remote, commit, kind = "push", plan = null }) {
    this.#db.prepare("INSERT OR REPLACE INTO genesis_publish_requests (approval_id, project_id, remote, commit_sha, created_at, kind, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(approvalId, projectId, remote, commit, this.#stamp(), kind, plan ? json(plan) : null);
  }

  takePublishRequest(approvalId) {
    const row = this.#db.prepare("SELECT * FROM genesis_publish_requests WHERE approval_id = ?").get(String(approvalId));
    if (!row) return null;
    this.#db.prepare("DELETE FROM genesis_publish_requests WHERE approval_id = ?").run(String(approvalId));
    return { approvalId: row.approval_id, projectId: row.project_id, remote: row.remote, commit: row.commit_sha, kind: row.kind ?? "push", plan: parse(row.plan_json) };
  }

  /** Projects that were mid-work when Atlas stopped. */
  interrupted() {
    return this.#db.prepare(`SELECT * FROM genesis_projects WHERE state IN (${ACTIVE_STATES.map(() => "?").join(", ")})`).all(...ACTIVE_STATES).map((row) => this.#project(row));
  }
}
