import { DatabaseSync } from "node:sqlite";

import {
  BUDGET_DIMENSIONS,
  SCHEMA_VERSION,
  agentSchema,
  assertSchema,
  newId,
  nowIso,
} from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * The agent family graph (blueprint §2–3).
 *
 * Agents form a tenant-scoped tree: every agent except a root has exactly one
 * parent, and everything an agent may do is derived from its parent by
 * narrowing — permissions must be a (glob-aware) subset, and budget is
 * reserved out of the parent's unallocated remainder. Role and family labels
 * are descriptive only: authorization never reads them.
 *
 * Every read and write takes a tenantId, and every SQL statement filters on
 * it, so one tenant's graph is invisible to another's.
 */

export class FamilyError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "FamilyError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const AGENT_TRANSITIONS = Object.freeze({
  proposed: ["authorized", "rejected"],
  authorized: ["idle", "running", "retired"],
  idle: ["running", "retired"],
  running: ["idle", "retired"],
  retired: [],
  rejected: [],
});
export const AGENT_STATES = Object.freeze(Object.keys(AGENT_TRANSITIONS));
const LIVE_STATES = ["authorized", "idle", "running"];

export const RELATIONSHIP_TYPES = Object.freeze([
  "parent_of", "cousin_collaboration", "supervises", "reviews", "guards", "mentors",
]);

export const DEFAULT_CAPS = Object.freeze({
  maxAgents: 64,
  maxDepth: 4,
  maxChildrenPerParent: 12,
  maxConcurrentRunning: 16,
  maxAgentsPerTask: 8,
  rootPermissions: ["*"],
});

// ---------------------------------------------------------------------------
// Permission and budget helpers
// ---------------------------------------------------------------------------

/**
 * True when `granted` covers `needed`. "*" covers everything; "browser.*"
 * covers "browser.navigate" and "browser.tabs.*"; a concrete permission covers
 * only itself, so a concrete grant never covers a wildcard request.
 */
export function permissionCovers(granted, needed) {
  if (granted === needed || granted === "*") return true;
  if (granted.endsWith(".*")) {
    const prefix = granted.slice(0, -1); // keeps trailing "."
    return needed.startsWith(prefix) && needed.length > prefix.length;
  }
  return false;
}

export function permissionsCover(grantedList, needed) {
  return grantedList.some((granted) => permissionCovers(granted, needed));
}

/** Returns the entries of `requested` not covered by `granted`. */
export function uncoveredPermissions(requested, granted) {
  return requested.filter((needed) => !permissionsCover(granted, needed));
}

function normalizePermissions(value) {
  if (!Array.isArray(value) || value.some((p) => typeof p !== "string" || !/^(\*|[a-z][a-z0-9_]*(\.([a-z][a-z0-9_]*|\*))*)$/.test(p))) {
    throw new FamilyError("INVALID_PERMISSIONS", "permissions must be dotted lower_snake_case strings, optionally ending in '.*'.");
  }
  return [...new Set(value)].sort();
}

export function zeroBudget() {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((d) => [d, 0]));
}

export function normalizeBudget(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FamilyError("INVALID_BUDGET", "budget must be an object.");
  }
  const unknown = Object.keys(value).filter((key) => !BUDGET_DIMENSIONS.includes(key));
  if (unknown.length) throw new FamilyError("INVALID_BUDGET", `Unknown budget dimensions: ${unknown.join(", ")}.`);
  const out = zeroBudget();
  for (const d of BUDGET_DIMENSIONS) {
    if (value[d] === undefined) continue;
    if (!Number.isInteger(value[d]) || value[d] < 0) throw new FamilyError("INVALID_BUDGET", `budget.${d} must be a non-negative integer.`);
    out[d] = value[d];
  }
  return out;
}

const addBudget = (a, b) => Object.fromEntries(BUDGET_DIMENSIONS.map((d) => [d, a[d] + b[d]]));
const subBudget = (a, b) => Object.fromEntries(BUDGET_DIMENSIONS.map((d) => [d, a[d] - b[d]]));

function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || !tenantId || tenantId.length > 128) {
    throw new FamilyError("TENANT_REQUIRED", "A tenantId is required for every family-graph operation.");
  }
  return tenantId;
}

function requireString(value, field) {
  if (typeof value !== "string" || !value) throw new FamilyError("INVALID_ARGUMENT", `'${field}' is required.`);
  return value;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class AgentFamilyRegistry {
  #db;
  #clock;
  #caps;
  #txDepth = 0;

  /**
   * @param {string|DatabaseSync} [filenameOrDb] a sqlite filename (default ":memory:") or an open DatabaseSync
   * @param {{caps?: object, clock?: () => Date}} [options]
   */
  constructor(filenameOrDb = ":memory:", { caps = {}, clock = () => new Date() } = {}) {
    this.#db = typeof filenameOrDb === "string" ? new DatabaseSync(filenameOrDb) : filenameOrDb;
    this.#clock = clock;
    this.#caps = { ...DEFAULT_CAPS, ...caps };
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS family_tenant_caps (
        tenant_id TEXT PRIMARY KEY, caps TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT, role TEXT NOT NULL, family TEXT NOT NULL,
        permissions TEXT NOT NULL, persistent INTEGER NOT NULL, budget TEXT NOT NULL,
        allocated TEXT NOT NULL, consumed TEXT NOT NULL, state TEXT NOT NULL,
        parent_id TEXT, depth INTEGER NOT NULL, task_id TEXT, requested_by TEXT, authorized_by TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id));
      CREATE INDEX IF NOT EXISTS agents_parent_idx ON agents(tenant_id, parent_id);
      CREATE TABLE IF NOT EXISTS agent_transitions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        from_state TEXT, to_state TEXT NOT NULL, actor TEXT, reason TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_relationships (
        tenant_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, type TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, from_agent, to_agent, type));
      CREATE TABLE IF NOT EXISTS assignments (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL, parent_task_id TEXT,
        owner_agent_id TEXT NOT NULL, delegated_by TEXT, correlation_id TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, payload TEXT NOT NULL, required_subtasks TEXT, result TEXT, verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, task_id));
      CREATE INDEX IF NOT EXISTS assignments_parent_idx ON assignments(tenant_id, parent_task_id);
      CREATE TABLE IF NOT EXISTS assignment_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL,
        from_owner TEXT, to_owner TEXT NOT NULL, reason TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
        source TEXT NOT NULL, destination TEXT NOT NULL, task_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
        schema_version TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_messages_task_idx ON agent_messages(tenant_id, task_id);
      CREATE TRIGGER IF NOT EXISTS agent_messages_no_update BEFORE UPDATE ON agent_messages BEGIN SELECT RAISE(ABORT, 'agent_messages are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS agent_messages_no_delete BEFORE DELETE ON agent_messages BEGIN SELECT RAISE(ABORT, 'agent_messages are append-only'); END;
      CREATE TABLE IF NOT EXISTS dead_letters (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL,
        reason TEXT NOT NULL, escalation_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cross_family_requests (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        to_family TEXT NOT NULL, task_id TEXT NOT NULL, subtask_id TEXT NOT NULL, scope TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id));
    `);
  }

  get db() { return this.#db; }
  now() { return nowIso(this.#clock); }

  /** Runs `fn` atomically; nests via savepoints. */
  transaction(fn) {
    const name = `fam_${this.#txDepth}`;
    const outer = this.#txDepth === 0;
    this.#db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.#txDepth += 1;
    try {
      const result = fn();
      this.#txDepth -= 1;
      this.#db.exec(outer ? "COMMIT" : `RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#txDepth -= 1;
      this.#db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }

  close() { this.#db.close(); }

  // -- caps ---------------------------------------------------------------

  setTenantCaps(tenantId, caps) {
    requireTenant(tenantId);
    const merged = { ...this.getTenantCaps(tenantId), ...caps };
    this.#db.prepare("INSERT INTO family_tenant_caps (tenant_id, caps) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET caps = excluded.caps")
      .run(tenantId, JSON.stringify(merged));
    return merged;
  }

  getTenantCaps(tenantId) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT caps FROM family_tenant_caps WHERE tenant_id = ?").get(tenantId);
    return { ...this.#caps, ...(row ? JSON.parse(row.caps) : {}) };
  }

  // -- agents -------------------------------------------------------------

  #row(tenantId, agentId) {
    return this.#db.prepare("SELECT * FROM agents WHERE tenant_id = ? AND id = ?").get(tenantId, agentId);
  }

  #hydrate(row) {
    if (!row) return null;
    const budget = JSON.parse(row.budget);
    const allocated = JSON.parse(row.allocated);
    const consumed = JSON.parse(row.consumed);
    return {
      schemaVersion: SCHEMA_VERSION,
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name ?? undefined,
      role: row.role,
      family: row.family,
      permissions: JSON.parse(row.permissions),
      persistent: Boolean(row.persistent),
      budget,
      allocated,
      consumed,
      remaining: subBudget(subBudget(budget, allocated), consumed),
      state: row.state,
      parentId: row.parent_id,
      depth: row.depth,
      taskId: row.task_id,
      requestedBy: row.requested_by,
      authorizedBy: row.authorized_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAgent(tenantId, agentId) {
    requireTenant(tenantId);
    return this.#hydrate(this.#row(tenantId, agentId));
  }

  requireAgent(tenantId, agentId) {
    const agent = this.getAgent(tenantId, agentId);
    if (!agent) throw new FamilyError("AGENT_NOT_FOUND", `Agent '${agentId}' does not exist in this tenant.`);
    return agent;
  }

  listAgents(tenantId, { state, family } = {}) {
    requireTenant(tenantId);
    return this.#db.prepare("SELECT * FROM agents WHERE tenant_id = ? ORDER BY created_at, rowid").all(tenantId)
      .map((row) => this.#hydrate(row))
      .filter((a) => (!state || (Array.isArray(state) ? state.includes(a.state) : a.state === state)) && (!family || a.family === family));
  }

  isLive(agent) { return Boolean(agent) && LIVE_STATES.includes(agent.state); }

  proposeAgent({ tenantId, parentId = null, role, family, name, permissions = [], persistent = false, budget = {}, requestedBy, taskId = null }) {
    requireTenant(tenantId);
    const perms = normalizePermissions(permissions);
    const normalizedBudget = normalizeBudget(budget);
    let depth = 0;
    if (parentId !== null) {
      const parent = this.requireAgent(tenantId, parentId);
      depth = parent.depth + 1;
    }
    const id = newId("agent");
    const record = {
      schemaVersion: SCHEMA_VERSION, id, tenantId, role, family, permissions: perms,
      persistent: Boolean(persistent), budget: normalizedBudget, ...(name ? { name } : {}),
    };
    assertSchema(agentSchema, record, "agent");
    const at = this.now();
    this.transaction(() => {
      this.#db.prepare(`INSERT INTO agents (tenant_id, id, name, role, family, permissions, persistent, budget, allocated, consumed,
        state, parent_id, depth, task_id, requested_by, authorized_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, NULL, ?, ?)`)
        .run(tenantId, id, name ?? null, role, family, JSON.stringify(perms), persistent ? 1 : 0, JSON.stringify(normalizedBudget),
          JSON.stringify(zeroBudget()), JSON.stringify(zeroBudget()), parentId, depth, taskId, requestedBy ?? null, at, at);
      this.#recordTransition(tenantId, id, null, "proposed", requestedBy, "proposed");
    });
    return this.getAgent(tenantId, id);
  }

  #recordTransition(tenantId, agentId, from, to, actor, reason) {
    this.#db.prepare("INSERT INTO agent_transitions (tenant_id, agent_id, from_state, to_state, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(tenantId, agentId, from, to, actor ?? null, reason ?? null, this.now());
  }

  #setState(tenantId, agentId, to, actor, reason) {
    const agent = this.requireAgent(tenantId, agentId);
    if (!AGENT_TRANSITIONS[agent.state]?.includes(to)) {
      throw new FamilyError("ILLEGAL_AGENT_TRANSITION", `Agent cannot move from '${agent.state}' to '${to}'.`, { from: agent.state, to });
    }
    this.#db.prepare("UPDATE agents SET state = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(to, this.now(), tenantId, agentId);
    this.#recordTransition(tenantId, agentId, agent.state, to, actor, reason);
    return agent;
  }

  transitions(tenantId, agentId) {
    requireTenant(tenantId);
    return this.#db.prepare("SELECT from_state AS \"from\", to_state AS \"to\", actor, reason, at FROM agent_transitions WHERE tenant_id = ? AND agent_id = ? ORDER BY seq")
      .all(tenantId, agentId).map((r) => ({ ...r }));
  }

  /**
   * Policy-checked authorization. Reads only permissions, budget, tree shape
   * and caps — never role or family, so a label cannot grant anything.
   * `policy` may carry `deny` globs and/or a `check(agent, parent)` hook
   * returning `{ allow: boolean, reason?: string }`.
   */
  authorizeAgent(tenantId, agentId, { authorizer, policy = {} } = {}) {
    requireTenant(tenantId);
    requireString(authorizer, "authorizer");
    try {
      return this.transaction(() => this.#authorize(tenantId, agentId, authorizer, policy));
    } catch (error) {
      // A policy refusal is durable: the proposal is rejected, and the reason recorded.
      if (error instanceof FamilyError && error.reject) {
        this.transaction(() => this.#setState(tenantId, agentId, "rejected", authorizer, `${error.code}: ${error.message}`));
      }
      throw error;
    }
  }

  #authorize(tenantId, agentId, authorizer, policy) {
    {
      const agent = this.requireAgent(tenantId, agentId);
      if (agent.state !== "proposed") throw new FamilyError("ILLEGAL_AGENT_TRANSITION", `Only a proposed agent can be authorized (is '${agent.state}').`);
      const caps = this.getTenantCaps(tenantId);
      const refuse = (code, message, details) => Object.assign(new FamilyError(code, message, details), { reject: true });
      let parent = null;
      if (agent.parentId) {
        parent = this.requireAgent(tenantId, agent.parentId);
        if (!this.isLive(parent)) throw refuse("PARENT_NOT_ACTIVE", `Parent '${parent.id}' is '${parent.state}'.`);
      }
      // Permissions: subset of parent (or of the tenant's root grant).
      const ceiling = parent ? parent.permissions : caps.rootPermissions;
      const extra = uncoveredPermissions(agent.permissions, ceiling);
      if (extra.length) throw refuse("PERMISSION_ESCALATION", `Permissions not held by the parent: ${extra.join(", ")}.`, { extra });
      const denied = agent.permissions.filter((p) => (policy.deny ?? []).some((d) => permissionCovers(d, p) || permissionCovers(p, d)));
      if (denied.length) throw refuse("POLICY_DENIED", `Policy denies: ${denied.join(", ")}.`, { denied });
      if (typeof policy.check === "function") {
        const verdict = policy.check(structuredClone(agent), parent && structuredClone(parent));
        if (!verdict?.allow) throw refuse("POLICY_DENIED", verdict?.reason ?? "Policy check refused the agent.");
      }
      // Caps.
      const live = this.listAgents(tenantId, { state: LIVE_STATES });
      if (live.length + 1 > caps.maxAgents) throw refuse("CAP_MAX_AGENTS", `Tenant cap of ${caps.maxAgents} agents reached.`);
      if (agent.depth > caps.maxDepth) throw refuse("CAP_MAX_DEPTH", `Depth ${agent.depth} exceeds cap ${caps.maxDepth}.`);
      if (parent) {
        const siblings = live.filter((a) => a.parentId === parent.id).length;
        if (siblings + 1 > caps.maxChildrenPerParent) throw refuse("CAP_MAX_CHILDREN", `Parent already has ${siblings} children (cap ${caps.maxChildrenPerParent}).`);
      }
      if (agent.taskId) {
        const perTask = live.filter((a) => a.taskId === agent.taskId).length;
        if (perTask + 1 > caps.maxAgentsPerTask) throw refuse("CAP_MAX_AGENTS_PER_TASK", `Task '${agent.taskId}' already has ${perTask} agents.`);
      }
      // Budget: reserve from the parent's unallocated remainder.
      if (parent) {
        const short = BUDGET_DIMENSIONS.filter((d) => agent.budget[d] > parent.remaining[d]);
        if (short.length) {
          throw refuse("BUDGET_EXCEEDS_PARENT", `Child budget exceeds parent's remaining allocation on: ${short.join(", ")}.`,
            { short, requested: agent.budget, available: parent.remaining });
        }
        this.#db.prepare("UPDATE agents SET allocated = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
          .run(JSON.stringify(addBudget(parent.allocated, agent.budget)), this.now(), tenantId, parent.id);
      }
      this.#setState(tenantId, agentId, "authorized", authorizer, "policy checks passed");
      this.#db.prepare("UPDATE agents SET authorized_by = ? WHERE tenant_id = ? AND id = ?").run(authorizer, tenantId, agentId);
      if (parent) {
        this.#insertRelationship(tenantId, parent.id, agentId, "parent_of");
        if (parent.parentId) this.#insertRelationship(tenantId, parent.parentId, agentId, "supervises");
      }
      return this.getAgent(tenantId, agentId);
    }
  }

  /** Convenience: propose + authorize in one policy-checked step. */
  spawnAgent(input, { authorizer, policy } = {}) {
    const proposed = this.proposeAgent(input);
    return this.authorizeAgent(input.tenantId, proposed.id, { authorizer: authorizer ?? input.requestedBy, policy });
  }

  markRunning(tenantId, agentId, { actor, reason } = {}) {
    return this.transaction(() => {
      const caps = this.getTenantCaps(tenantId);
      const running = this.listAgents(tenantId, { state: "running" }).length;
      const agent = this.requireAgent(tenantId, agentId);
      if (agent.state !== "running" && running + 1 > caps.maxConcurrentRunning) {
        throw new FamilyError("CAP_MAX_RUNNING", `Tenant already has ${running} running agents (cap ${caps.maxConcurrentRunning}).`);
      }
      if (agent.state === "running") return agent;
      this.#setState(tenantId, agentId, "running", actor, reason ?? "task started");
      return this.getAgent(tenantId, agentId);
    });
  }

  /** Task finished: persistent agents go idle; temporary ones retire. */
  completeAgentWork(tenantId, agentId, { actor, reason } = {}) {
    const agent = this.requireAgent(tenantId, agentId);
    if (agent.persistent) {
      if (agent.state === "idle") return agent;
      this.#setState(tenantId, agentId, "idle", actor, reason ?? "task complete");
      return this.getAgent(tenantId, agentId);
    }
    return this.retireAgent(tenantId, agentId, { actor, reason: reason ?? "temporary agent task complete" });
  }

  /** Retires an agent and returns its unused reservation to the parent. */
  retireAgent(tenantId, agentId, { actor, reason } = {}) {
    return this.transaction(() => {
      const agent = this.requireAgent(tenantId, agentId);
      this.#setState(tenantId, agentId, "retired", actor, reason ?? "retired");
      if (agent.parentId) {
        const parent = this.requireAgent(tenantId, agent.parentId);
        this.#db.prepare("UPDATE agents SET allocated = ?, consumed = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
          .run(JSON.stringify(subBudget(parent.allocated, agent.budget)), JSON.stringify(addBudget(parent.consumed, agent.consumed)),
            this.now(), tenantId, parent.id);
      }
      return this.getAgent(tenantId, agentId);
    });
  }

  chargeBudget(tenantId, agentId, usage) {
    return this.transaction(() => {
      const agent = this.requireAgent(tenantId, agentId);
      const charge = normalizeBudget(usage);
      const over = BUDGET_DIMENSIONS.filter((d) => charge[d] > agent.remaining[d]);
      if (over.length) throw new FamilyError("BUDGET_EXHAUSTED", `Charge exceeds remaining budget on: ${over.join(", ")}.`);
      this.#db.prepare("UPDATE agents SET consumed = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(JSON.stringify(addBudget(agent.consumed, charge)), this.now(), tenantId, agentId);
      return this.getAgent(tenantId, agentId);
    });
  }

  /** Reuse before spawn: an idle/authorized persistent agent whose permissions cover the need. */
  findReusableAgent(tenantId, { family, role, requiredPermissions = [] } = {}) {
    requireTenant(tenantId);
    return this.listAgents(tenantId, { state: ["authorized", "idle"] }).find((a) =>
      a.persistent
      && (!family || a.family === family)
      && (!role || a.role === role)
      && uncoveredPermissions(requiredPermissions, a.permissions).length === 0) ?? null;
  }

  // -- relationships ------------------------------------------------------

  #insertRelationship(tenantId, from, to, type) {
    this.#db.prepare("INSERT OR IGNORE INTO agent_relationships (tenant_id, from_agent, to_agent, type, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tenantId, from, to, type, this.now());
  }

  /**
   * Adds a typed edge. parent_of edges go through reparentAgent (cycle and
   * permission checked); cousin_collaboration requires actual cousins.
   */
  addRelationship(tenantId, { from, to, type }) {
    requireTenant(tenantId);
    if (!RELATIONSHIP_TYPES.includes(type)) throw new FamilyError("INVALID_RELATIONSHIP", `Unknown relationship '${type}'.`);
    if (from === to) throw new FamilyError("INVALID_RELATIONSHIP", "An agent cannot relate to itself.");
    if (type === "parent_of") return this.reparentAgent(tenantId, to, from);
    this.requireAgent(tenantId, from);
    this.requireAgent(tenantId, to);
    if (type === "cousin_collaboration" && !this.cousins(tenantId, from).some((c) => c.id === to)) {
      throw new FamilyError("NOT_COUSINS", "cousin_collaboration requires agents sharing a grandparent through different parents.");
    }
    if (type === "supervises" && !this.ancestors(tenantId, to).some((a) => a.id === from)) {
      throw new FamilyError("INVALID_RELATIONSHIP", "Only an ancestor can supervise an agent.");
    }
    this.#insertRelationship(tenantId, from, to, type);
    return { from, to, type };
  }

  relationships(tenantId, agentId, { type } = {}) {
    requireTenant(tenantId);
    return this.#db.prepare("SELECT from_agent AS \"from\", to_agent AS \"to\", type FROM agent_relationships WHERE tenant_id = ? AND (from_agent = ? OR to_agent = ?) ORDER BY created_at, rowid")
      .all(tenantId, agentId, agentId).map((r) => ({ ...r })).filter((r) => !type || r.type === type);
  }

  /** Moves an agent under a new parent. Refuses cycles and permission escalation. */
  reparentAgent(tenantId, childId, newParentId) {
    requireTenant(tenantId);
    return this.transaction(() => {
      const child = this.requireAgent(tenantId, childId);
      const parent = this.requireAgent(tenantId, newParentId);
      if (childId === newParentId || this.#ancestorIds(tenantId, newParentId).includes(childId)) {
        throw new FamilyError("CYCLE_DETECTED", `Making '${newParentId}' the parent of '${childId}' would create a cycle.`);
      }
      const extra = uncoveredPermissions(child.permissions, parent.permissions);
      if (extra.length) throw new FamilyError("PERMISSION_ESCALATION", `New parent does not hold: ${extra.join(", ")}.`);
      const caps = this.getTenantCaps(tenantId);
      const deepest = Math.max(0, ...this.descendants(tenantId, childId).map((d) => d.depth - child.depth));
      if (parent.depth + 1 + deepest > caps.maxDepth) throw new FamilyError("CAP_MAX_DEPTH", "Reparenting would exceed the depth cap.");
      this.#db.prepare("DELETE FROM agent_relationships WHERE tenant_id = ? AND to_agent = ? AND type IN ('parent_of','supervises')").run(tenantId, childId);
      this.#db.prepare("UPDATE agents SET parent_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(newParentId, this.now(), tenantId, childId);
      this.#insertRelationship(tenantId, newParentId, childId, "parent_of");
      if (parent.parentId) this.#insertRelationship(tenantId, parent.parentId, childId, "supervises");
      const shift = parent.depth + 1 - child.depth;
      for (const id of [childId, ...this.descendants(tenantId, childId).map((d) => d.id)]) {
        this.#db.prepare("UPDATE agents SET depth = depth + ? WHERE tenant_id = ? AND id = ?").run(shift, tenantId, id);
      }
      return this.getAgent(tenantId, childId);
    });
  }

  #ancestorIds(tenantId, agentId) {
    const ids = [];
    const seen = new Set([agentId]);
    let row = this.#row(tenantId, agentId);
    while (row?.parent_id) {
      if (seen.has(row.parent_id)) throw new FamilyError("CYCLE_DETECTED", "Existing parent chain contains a cycle.");
      seen.add(row.parent_id);
      ids.push(row.parent_id);
      row = this.#row(tenantId, row.parent_id);
    }
    return ids;
  }

  parent(tenantId, agentId) {
    const agent = this.requireAgent(tenantId, agentId);
    return agent.parentId ? this.getAgent(tenantId, agent.parentId) : null;
  }

  grandparent(tenantId, agentId) {
    const parent = this.parent(tenantId, agentId);
    return parent ? this.parent(tenantId, parent.id) : null;
  }

  children(tenantId, agentId) {
    requireTenant(tenantId);
    return this.#db.prepare("SELECT * FROM agents WHERE tenant_id = ? AND parent_id = ? ORDER BY created_at, rowid").all(tenantId, agentId)
      .map((row) => this.#hydrate(row));
  }

  siblings(tenantId, agentId) {
    const agent = this.requireAgent(tenantId, agentId);
    if (!agent.parentId) return [];
    return this.children(tenantId, agent.parentId).filter((a) => a.id !== agentId);
  }

  cousins(tenantId, agentId) {
    const agent = this.requireAgent(tenantId, agentId);
    const grand = this.grandparent(tenantId, agentId);
    if (!grand) return [];
    return this.children(tenantId, grand.id)
      .filter((uncle) => uncle.id !== agent.parentId)
      .flatMap((uncle) => this.children(tenantId, uncle.id));
  }

  ancestors(tenantId, agentId) {
    requireTenant(tenantId);
    return this.#ancestorIds(tenantId, agentId).map((id) => this.getAgent(tenantId, id));
  }

  descendants(tenantId, agentId) {
    const out = [];
    const queue = [agentId];
    const seen = new Set(queue);
    while (queue.length) {
      for (const child of this.children(tenantId, queue.shift())) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        queue.push(child.id);
      }
    }
    return out;
  }

  isDescendant(tenantId, agentId, ancestorId) {
    return this.#ancestorIds(tenantId, agentId).includes(ancestorId);
  }

  /** Nested JSON for a UI. */
  familyTree(tenantId, rootId) {
    const root = this.requireAgent(tenantId, rootId);
    const build = (agent, seen) => ({
      id: agent.id,
      name: agent.name ?? null,
      role: agent.role,
      family: agent.family,
      state: agent.state,
      persistent: agent.persistent,
      depth: agent.depth,
      permissions: agent.permissions,
      budget: agent.budget,
      relationships: this.relationships(tenantId, agent.id).filter((r) => r.from === agent.id && r.type !== "parent_of"),
      children: this.children(tenantId, agent.id).filter((c) => !seen.has(c.id)).map((c) => build(c, new Set([...seen, c.id]))),
    });
    return build(root, new Set([root.id]));
  }
}
