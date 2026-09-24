import { newCorrelationId, newId } from "../../../../../packages/atlas-contracts/src/index.mjs";

import { FamilyError } from "./family-graph.mjs";
import { MessageBus, SYSTEM_SOURCE } from "./messages.mjs";

export const ASSIGNMENT_STATES = Object.freeze(["assigned", "running", "waiting_for_dependency", "verifying", "completed", "cancelled"]);
const OPEN_STATES = new Set(["assigned", "running", "waiting_for_dependency", "verifying"]);

/** Keys that must never ride along in a cross-family request's scope. */
const FORBIDDEN_SCOPE_KEY = /(secret|token|password|passwd|credential|api_?key|permission|cookie|session|private_?key|authorization)/i;

function assertScopedPayload(value, path = "scope") {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SCOPE_KEY.test(key)) {
      throw new FamilyError("SCOPE_LEAKS_AUTHORITY", `Cross-family scope may not carry '${path}.${key}'; the helper uses only its own permissions.`);
    }
    assertScopedPayload(child, `${path}.${key}`);
  }
}

/**
 * Task delegation over the family graph. Every task has exactly one
 * accountable owner (UNIQUE(tenant_id, task_id) on assignments); ownership
 * changes only through reassignTask, which records the transfer.
 */
export class TaskDelegation {
  #reg;
  #bus;

  constructor(registry, bus = new MessageBus(registry)) {
    this.#reg = registry;
    this.#bus = bus;
  }

  get bus() { return this.#bus; }

  #hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      taskId: row.task_id,
      parentTaskId: row.parent_task_id,
      ownerAgentId: row.owner_agent_id,
      delegatedBy: row.delegated_by,
      correlationId: row.correlation_id,
      kind: row.kind,
      state: row.state,
      payload: JSON.parse(row.payload),
      requiredSubtasks: row.required_subtasks ? JSON.parse(row.required_subtasks) : [],
      result: row.result === null ? null : JSON.parse(row.result),
      verified: Boolean(row.verified),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAssignment(tenantId, taskId) {
    if (typeof tenantId !== "string" || !tenantId) throw new FamilyError("TENANT_REQUIRED", "A tenantId is required.");
    return this.#hydrate(this.#reg.db.prepare("SELECT * FROM assignments WHERE tenant_id = ? AND task_id = ?").get(tenantId, taskId));
  }

  #requireAssignment(tenantId, taskId) {
    const a = this.getAssignment(tenantId, taskId);
    if (!a) throw new FamilyError("TASK_NOT_FOUND", `Task '${taskId}' has no assignment in this tenant.`);
    return a;
  }

  subtasks(tenantId, taskId) {
    return this.#reg.db.prepare("SELECT * FROM assignments WHERE tenant_id = ? AND parent_task_id = ? ORDER BY created_at, rowid")
      .all(tenantId, taskId).map((r) => this.#hydrate(r));
  }

  ownershipHistory(tenantId, taskId) {
    return this.#reg.db.prepare("SELECT from_owner AS \"from\", to_owner AS \"to\", reason, at FROM assignment_history WHERE tenant_id = ? AND task_id = ? ORDER BY seq")
      .all(tenantId, taskId).map((r) => ({ ...r }));
  }

  #setState(tenantId, taskId, state, extra = {}) {
    const sets = ["state = ?", "updated_at = ?"];
    const args = [state, this.#reg.now()];
    if ("result" in extra) { sets.push("result = ?"); args.push(JSON.stringify(extra.result ?? null)); }
    if ("verified" in extra) { sets.push("verified = ?"); args.push(extra.verified ? 1 : 0); }
    if ("requiredSubtasks" in extra) { sets.push("required_subtasks = ?"); args.push(JSON.stringify(extra.requiredSubtasks)); }
    this.#reg.db.prepare(`UPDATE assignments SET ${sets.join(", ")} WHERE tenant_id = ? AND task_id = ?`).run(...args, tenantId, taskId);
  }

  #insert(tenantId, { taskId, parentTaskId = null, ownerAgentId, delegatedBy = null, correlationId, kind, payload }) {
    if (this.getAssignment(tenantId, taskId)) {
      throw new FamilyError("TASK_ALREADY_OWNED", `Task '${taskId}' already has an accountable owner; use reassignTask to transfer it.`);
    }
    const at = this.#reg.now();
    this.#reg.db.prepare(`INSERT INTO assignments (tenant_id, id, task_id, parent_task_id, owner_agent_id, delegated_by, correlation_id, kind, state, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?)`)
      .run(tenantId, newId("step"), taskId, parentTaskId, ownerAgentId, delegatedBy, correlationId, kind, JSON.stringify(payload ?? {}), at, at);
    this.#reg.db.prepare("INSERT INTO assignment_history (tenant_id, task_id, from_owner, to_owner, reason, at) VALUES (?, ?, NULL, ?, ?, ?)")
      .run(tenantId, taskId, ownerAgentId, kind, at);
    return this.getAssignment(tenantId, taskId);
  }

  #requireLive(tenantId, agentId, label) {
    const agent = this.#reg.requireAgent(tenantId, agentId);
    if (!this.#reg.isLive(agent)) throw new FamilyError("AGENT_NOT_ACTIVE", `${label} '${agentId}' is '${agent.state}'.`);
    return agent;
  }

  /** Owners along a task's parent chain (the delegation chain). */
  #delegationChain(tenantId, taskId) {
    const chain = [];
    const seen = new Set();
    let current = taskId ? this.getAssignment(tenantId, taskId) : null;
    while (current) {
      if (seen.has(current.taskId)) throw new FamilyError("CYCLE_DETECTED", "Task delegation chain contains a cycle.");
      seen.add(current.taskId);
      chain.push(current);
      current = current.parentTaskId ? this.getAssignment(tenantId, current.parentTaskId) : null;
    }
    return chain;
  }

  /** Makes an agent the accountable owner of a top-level task. */
  assignTask({ tenantId, agentId, taskId, correlationId = newCorrelationId(), payload = {}, assignedBy = SYSTEM_SOURCE }) {
    return this.#reg.transaction(() => {
      this.#requireLive(tenantId, agentId, "Owner");
      const assignment = this.#insert(tenantId, { taskId, ownerAgentId: agentId, delegatedBy: null, correlationId, kind: "direct", payload });
      const sent = this.#bus.sendMessage({ tenantId, type: "TASK_ASSIGNMENT", source: assignedBy === SYSTEM_SOURCE ? SYSTEM_SOURCE : assignedBy, destination: agentId, taskId, correlationId, payload });
      return { assignment, message: sent.message };
    });
  }

  /**
   * Delegates a (sub)task downward. Allowed only to a strict descendant of the
   * delegator; the delegator must own `parentTaskId` when given; nobody already
   * in the delegation chain may receive it again.
   */
  delegateTask({ tenantId, fromAgentId, toAgentId, taskId, parentTaskId = null, correlationId, payload = {} }) {
    return this.#reg.transaction(() => {
      this.#requireLive(tenantId, fromAgentId, "Delegator");
      this.#requireLive(tenantId, toAgentId, "Delegate");
      if (fromAgentId === toAgentId) throw new FamilyError("SELF_DELEGATION", "An agent cannot delegate a task to itself.");
      if (!this.#reg.isDescendant(tenantId, toAgentId, fromAgentId)) {
        throw new FamilyError("DELEGATION_NOT_DOWNWARD", "Tasks may only be delegated to the delegator's own descendants.");
      }
      let parent = null;
      if (parentTaskId) {
        parent = this.#requireAssignment(tenantId, parentTaskId);
        if (parent.ownerAgentId !== fromAgentId) throw new FamilyError("NOT_ACCOUNTABLE_OWNER", `Only the owner of '${parentTaskId}' may delegate from it.`);
        if (!OPEN_STATES.has(parent.state)) throw new FamilyError("TASK_CLOSED", `Parent task is '${parent.state}'.`);
        const chain = this.#delegationChain(tenantId, parentTaskId);
        if (chain.some((a) => a.taskId === taskId)) throw new FamilyError("CYCLE_DETECTED", "A task cannot be its own ancestor.");
        if (chain.some((a) => a.ownerAgentId === toAgentId)) {
          throw new FamilyError("RECURSIVE_DELEGATION", "The delegate is already delegating a task in this chain.");
        }
      }
      const corr = correlationId ?? parent?.correlationId ?? newCorrelationId();
      const assignment = this.#insert(tenantId, { taskId, parentTaskId, ownerAgentId: toAgentId, delegatedBy: fromAgentId, correlationId: corr, kind: "delegated", payload });
      const sent = this.#bus.sendMessage({ tenantId, type: "TASK_ASSIGNMENT", source: fromAgentId, destination: toAgentId, taskId, correlationId: corr, payload: { parentTaskId, ...payload } });
      return { assignment, message: sent.message };
    });
  }

  /** Explicit ownership transfer. `by` must be the owner or one of the owner's ancestors. */
  reassignTask({ tenantId, taskId, toAgentId, by, reason = "reassigned" }) {
    return this.#reg.transaction(() => {
      const a = this.#requireAssignment(tenantId, taskId);
      if (!OPEN_STATES.has(a.state)) throw new FamilyError("TASK_CLOSED", `Task is '${a.state}'.`);
      this.#requireLive(tenantId, toAgentId, "New owner");
      if (by !== a.ownerAgentId && !this.#reg.isDescendant(tenantId, a.ownerAgentId, by)) {
        throw new FamilyError("NOT_ACCOUNTABLE_OWNER", "Only the owner or its ancestor may reassign a task.");
      }
      if (by !== toAgentId && !this.#reg.isDescendant(tenantId, toAgentId, by)) {
        throw new FamilyError("DELEGATION_NOT_DOWNWARD", "A task can only be reassigned within the reassigner's subtree.");
      }
      if (this.#delegationChain(tenantId, a.parentTaskId).some((p) => p.ownerAgentId === toAgentId)) {
        throw new FamilyError("RECURSIVE_DELEGATION", "The new owner is already delegating a task in this chain.");
      }
      const previous = a.ownerAgentId;
      this.#reg.db.prepare("UPDATE assignments SET owner_agent_id = ?, updated_at = ? WHERE tenant_id = ? AND task_id = ?").run(toAgentId, this.#reg.now(), tenantId, taskId);
      this.#reg.db.prepare("INSERT INTO assignment_history (tenant_id, task_id, from_owner, to_owner, reason, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(tenantId, taskId, previous, toAgentId, reason, this.#reg.now());
      this.#bus.sendMessage({ tenantId, type: "CANCEL", source: by, destination: previous, taskId, correlationId: a.correlationId, payload: { reason: "ownership_transferred", newOwner: toAgentId } });
      this.#bus.sendMessage({ tenantId, type: "TASK_ASSIGNMENT", source: by, destination: toAgentId, taskId, correlationId: a.correlationId, payload: { reassignedFrom: previous, ...a.payload } });
      return this.getAssignment(tenantId, taskId);
    });
  }

  /**
   * Asks an agent of another family for help with a scoped subtask. The
   * helper gets a new subtask it owns and uses only its own permissions; the
   * request carries only the scope — never permissions, secrets or tokens.
   */
  requestCrossFamilyHelp({ tenantId, fromAgentId, toFamily, toAgentId, taskId, subtaskId = newId("task"), scope, correlationId }) {
    return this.#reg.transaction(() => {
      const from = this.#requireLive(tenantId, fromAgentId, "Requester");
      const task = this.#requireAssignment(tenantId, taskId);
      if (task.ownerAgentId !== fromAgentId) throw new FamilyError("NOT_ACCOUNTABLE_OWNER", "Only the task owner may request cross-family help.");
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new FamilyError("INVALID_ARGUMENT", "scope must be an object.");
      assertScopedPayload(scope);
      let helper;
      if (toAgentId) {
        helper = this.#requireLive(tenantId, toAgentId, "Helper");
      } else {
        const candidates = this.#reg.listAgents(tenantId, { family: toFamily, state: ["authorized", "idle", "running"] });
        helper = candidates.find((a) => a.state !== "running" && this.#reg.children(tenantId, a.id).length === 0)
          ?? candidates.find((a) => a.state !== "running") ?? candidates[0];
        if (!helper) throw new FamilyError("NO_HELPER", `No live agent in family '${toFamily}'.`);
      }
      if (helper.family === from.family) throw new FamilyError("SAME_FAMILY", "Cross-family help must go to a different family.");
      const requestId = newId("message");
      const corr = correlationId ?? task.correlationId;
      const payload = { requestId, scope: structuredClone(scope) };
      const assignment = this.#insert(tenantId, { taskId: subtaskId, parentTaskId: taskId, ownerAgentId: helper.id, delegatedBy: fromAgentId, correlationId: corr, kind: "cross_family", payload });
      this.#reg.db.prepare(`INSERT INTO cross_family_requests (tenant_id, id, from_agent, to_agent, to_family, task_id, subtask_id, scope, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
        .run(tenantId, requestId, fromAgentId, helper.id, helper.family, taskId, subtaskId, JSON.stringify(scope), this.#reg.now());
      const sent = this.#bus.sendMessage({ tenantId, type: "CROSS_FAMILY_REQUEST", source: fromAgentId, destination: helper.id, taskId: subtaskId, correlationId: corr, payload: { requestId, parentTaskId: taskId, scope } });
      return { requestId, helper, assignment, message: sent.message };
    });
  }

  listCrossFamilyRequests(tenantId) {
    return this.#reg.db.prepare("SELECT * FROM cross_family_requests WHERE tenant_id = ? ORDER BY created_at, rowid").all(tenantId)
      .map((r) => ({ id: r.id, fromAgentId: r.from_agent, toAgentId: r.to_agent, toFamily: r.to_family, taskId: r.task_id, subtaskId: r.subtask_id, scope: JSON.parse(r.scope), state: r.state }));
  }

  /** The owner parks its task until every listed subtask has a verified RESULT. */
  waitForSubtasks({ tenantId, taskId, agentId, subtaskIds }) {
    return this.#reg.transaction(() => {
      const a = this.#requireAssignment(tenantId, taskId);
      if (a.ownerAgentId !== agentId) throw new FamilyError("NOT_ACCOUNTABLE_OWNER", "Only the owner may wait on subtasks.");
      const children = new Set(this.subtasks(tenantId, taskId).map((s) => s.taskId));
      const unknown = subtaskIds.filter((id) => !children.has(id));
      if (unknown.length) throw new FamilyError("UNKNOWN_SUBTASK", `Not subtasks of '${taskId}': ${unknown.join(", ")}.`);
      this.#setState(tenantId, taskId, "waiting_for_dependency", { requiredSubtasks: [...new Set(subtaskIds)] });
      return this.#maybeResume(tenantId, taskId);
    });
  }

  dependencyStatus(tenantId, taskId) {
    const a = this.#requireAssignment(tenantId, taskId);
    const required = a.requiredSubtasks;
    const subs = required.map((id) => this.#requireAssignment(tenantId, id));
    const satisfied = subs.filter((s) => s.state === "completed" && s.verified).map((s) => s.taskId);
    const pending = required.filter((id) => !satisfied.includes(id));
    return { taskId, state: a.state, required, satisfied, pending, ready: pending.length === 0 };
  }

  #maybeResume(tenantId, taskId) {
    const status = this.dependencyStatus(tenantId, taskId);
    if (status.state === "waiting_for_dependency" && status.ready) this.#setState(tenantId, taskId, "running");
    return this.getAssignment(tenantId, taskId);
  }

  /**
   * The owner of a subtask reports its result. A RESULT goes to the delegator.
   * Only a verified result completes the subtask; an unverified one leaves it
   * in 'verifying' and cannot satisfy a dependency or be merged.
   */
  submitResult({ tenantId, agentId, taskId, result, verified = false }) {
    return this.#reg.transaction(() => {
      const a = this.#requireAssignment(tenantId, taskId);
      if (a.ownerAgentId !== agentId) throw new FamilyError("NOT_ACCOUNTABLE_OWNER", "Only the accountable owner may submit a result.");
      if (!OPEN_STATES.has(a.state)) throw new FamilyError("TASK_CLOSED", `Task is '${a.state}'.`);
      const isVerified = verified === true;
      this.#setState(tenantId, taskId, isVerified ? "completed" : "verifying", { result, verified: isVerified });
      let message = null;
      if (a.delegatedBy) {
        message = this.#bus.sendMessage({ tenantId, type: "RESULT", source: agentId, destination: a.delegatedBy, taskId, correlationId: a.correlationId, payload: { result, verified: isVerified, parentTaskId: a.parentTaskId } }).message;
      }
      if (a.kind === "cross_family" && isVerified) {
        this.#reg.db.prepare("UPDATE cross_family_requests SET state = 'completed' WHERE tenant_id = ? AND subtask_id = ?").run(tenantId, taskId);
      }
      if (isVerified) {
        const stillOpen = this.#reg.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE tenant_id = ? AND owner_agent_id = ? AND state IN ('assigned','running','waiting_for_dependency','verifying')")
          .get(tenantId, agentId).n;
        const owner = this.#reg.getAgent(tenantId, agentId);
        if (!stillOpen && this.#reg.isLive(owner) && owner.state !== "idle") this.#reg.completeAgentWork(tenantId, agentId, { actor: agentId });
      }
      if (a.parentTaskId) this.#maybeResume(tenantId, a.parentTaskId);
      return { assignment: this.getAssignment(tenantId, taskId), message };
    });
  }

  /** Merges subtask results; accepts only verified ones and only once all are in. */
  mergeResults(tenantId, taskId, { subtaskIds } = {}) {
    const a = this.#requireAssignment(tenantId, taskId);
    const ids = subtaskIds ?? (a.requiredSubtasks.length ? a.requiredSubtasks : this.subtasks(tenantId, taskId).map((s) => s.taskId));
    const subs = ids.map((id) => this.#requireAssignment(tenantId, id));
    const foreign = subs.filter((s) => s.parentTaskId !== taskId);
    if (foreign.length) throw new FamilyError("UNKNOWN_SUBTASK", `Not subtasks of '${taskId}'.`);
    const missing = subs.filter((s) => s.result === null && !s.verified);
    if (missing.length) throw new FamilyError("DEPENDENCIES_PENDING", `No result yet for: ${missing.map((s) => s.taskId).join(", ")}.`);
    const unverified = subs.filter((s) => !s.verified);
    if (unverified.length) throw new FamilyError("UNVERIFIED_RESULT", `Refusing to merge unverified results: ${unverified.map((s) => s.taskId).join(", ")}.`);
    return { taskId, results: subs.map((s) => ({ taskId: s.taskId, ownerAgentId: s.ownerAgentId, result: s.result })) };
  }

  /**
   * Cancels a task and every delegated descendant assignment, sending CANCEL
   * to each owner. Returns the assignments that were cancelled.
   */
  cancelTask(tenantId, taskId, { by = SYSTEM_SOURCE, reason = "cancelled" } = {}) {
    return this.#reg.transaction(() => {
      const root = this.#requireAssignment(tenantId, taskId);
      const cancelled = [];
      const visit = (a, seen) => {
        if (seen.has(a.taskId)) return;
        seen.add(a.taskId);
        if (OPEN_STATES.has(a.state)) {
          this.#setState(tenantId, a.taskId, "cancelled");
          this.#bus.sendMessage({ tenantId, type: "CANCEL", source: by, destination: a.ownerAgentId, taskId: a.taskId, correlationId: a.correlationId, payload: { reason, rootTaskId: taskId } });
          cancelled.push(this.getAssignment(tenantId, a.taskId));
        }
        for (const child of this.subtasks(tenantId, a.taskId)) visit(child, seen);
      };
      visit(root, new Set());
      return cancelled;
    });
  }
}
