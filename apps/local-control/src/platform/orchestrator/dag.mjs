import { TASK_TERMINAL_STATES, canTransition } from "../../../../../packages/atlas-contracts/src/index.mjs";

import { MissionPlanError, normalizeMissionPlan } from "../../agent/mission-scheduler.mjs";
import { OrchestratorError, requireTenant } from "./store.mjs";

/**
 * Durable task DAG (blueprint §3, §11).
 *
 * A task becomes runnable only when every task it depends on has completed
 * and every child task (tasks whose `parentTaskId` names it) has reached a
 * terminal state — a parent waits for its children. Edges live in the
 * orchestrator database, tenant-scoped, and an edge that would close a cycle
 * is refused at insert time, so readiness can never deadlock on itself.
 *
 * Readiness is computed, not stored: the task store is the single source of
 * truth for status, so there is no second copy to drift.
 *
 * This is an adapter, not a second scheduler. Cycle detection is delegated to
 * agent/mission-scheduler.mjs (`normalizeMissionPlan`), and `toMissionPlan()`
 * turns a set of durable platform tasks into a plan that MissionScheduler
 * executes (bounded concurrency, resource locks, provider throttling). The
 * DAG only adds what that scheduler lacks: durable, tenant-scoped edges
 * across platform tasks, parent-waits-for-children, deadlines and
 * partial-result reporting.
 */
const SCAN_LIMIT = 100_000;
const SATISFIED = "completed";
const UNSATISFIABLE = new Set(["failed", "cancelled", "archived"]);

export class TaskDag {
  #store;
  #orch;

  constructor({ store, orchestratorStore }) {
    if (!store || !orchestratorStore) throw new OrchestratorError("MISCONFIGURED", "TaskDag needs a task store and an orchestrator store.");
    this.#store = store;
    this.#orch = orchestratorStore;
  }

  #requireTask(tenantId, taskId) {
    const task = this.#store.getTask(tenantId, taskId);
    if (!task) throw new OrchestratorError("NOT_FOUND", "No such task in this tenant.");
    return task;
  }

  /** `taskId` will not run until `dependsOnTaskId` completes. Refuses self-loops and cycles. */
  addDependency(tenantId, taskId, dependsOnTaskId) {
    requireTenant(tenantId);
    this.#requireTask(tenantId, taskId);
    this.#requireTask(tenantId, dependsOnTaskId);
    if (taskId === dependsOnTaskId) throw new OrchestratorError("DEPENDENCY_CYCLE", "A task cannot depend on itself.", { path: [taskId, taskId] });
    return this.#orch.transaction(() => {
      // Validate the whole waits-for graph with the new edge using the mission
      // scheduler's own acyclicity check, so both agree on what a cycle is.
      try {
        this.#waitsForPlan(tenantId, [[taskId, dependsOnTaskId]]);
      } catch (error) {
        if (error instanceof MissionPlanError && error.code === "DEPENDENCY_CYCLE") {
          throw new OrchestratorError("DEPENDENCY_CYCLE", "Adding this dependency would create a cycle.", { cause: error.message });
        }
        throw error;
      }
      this.#orch.db.prepare(
        "INSERT INTO task_dependencies (tenant_id, task_id, depends_on_task_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      ).run(tenantId, taskId, dependsOnTaskId, this.#orch.now());
      return { taskId, dependsOnTaskId };
    });
  }

  removeDependency(tenantId, taskId, dependsOnTaskId) {
    requireTenant(tenantId);
    const result = this.#orch.db.prepare("DELETE FROM task_dependencies WHERE tenant_id = ? AND task_id = ? AND depends_on_task_id = ?")
      .run(tenantId, taskId, dependsOnTaskId);
    return Number(result.changes) === 1;
  }

  dependenciesOf(tenantId, taskId) {
    requireTenant(tenantId);
    return this.#orch.db.prepare("SELECT depends_on_task_id AS id FROM task_dependencies WHERE tenant_id = ? AND task_id = ? ORDER BY created_at, rowid")
      .all(tenantId, taskId).map((row) => row.id);
  }

  dependentsOf(tenantId, taskId) {
    requireTenant(tenantId);
    return this.#orch.db.prepare("SELECT task_id AS id FROM task_dependencies WHERE tenant_id = ? AND depends_on_task_id = ? ORDER BY created_at, rowid")
      .all(tenantId, taskId).map((row) => row.id);
  }

  childrenOf(tenantId, taskId) {
    return this.#store.listTasks(tenantId, { limit: SCAN_LIMIT }).filter((task) => task.parentTaskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /**
   * The tenant's waits-for graph as a mission plan: a task waits for its
   * dependencies and for its children (a parent waits for its children, so a
   * child depending on its own ancestor is a cycle). `extraEdges` are
   * [taskId, dependsOnId] pairs not yet stored. Throws MissionPlanError on a
   * cycle.
   */
  #waitsForPlan(tenantId, extraEdges = [], taskIds = undefined) {
    const tasks = this.#store.listTasks(tenantId, { limit: SCAN_LIMIT })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const include = taskIds ? new Set(taskIds) : new Set(tasks.map((task) => task.id));
    const waits = new Map([...include].map((id) => [id, new Set()]));
    const edge = (from, to) => { if (include.has(from) && include.has(to)) waits.get(from).add(to); };
    for (const task of tasks) {
      if (task.parentTaskId) edge(task.parentTaskId, task.id);
      for (const dep of this.dependenciesOf(tenantId, task.id)) edge(task.id, dep);
    }
    for (const [from, to] of extraEdges) edge(from, to);
    return normalizeMissionPlan({
      id: "platform-dag",
      children: tasks.filter((task) => include.has(task.id)).map((task) => ({
        id: task.id,
        objective: task.objective,
        dependencies: [...waits.get(task.id)],
        metadata: { tenantId, status: task.status, parentTaskId: task.parentTaskId ?? null },
      })),
    });
  }

  /**
   * A MissionScheduler plan for the given tasks (default: every non-terminal
   * task of the tenant plus everything it waits for). Hand it to
   * `new MissionScheduler({ plan, execute })`; `execute` receives `{ child }`
   * where `child.id` is the platform task id. Tasks that already completed
   * are included so their dependents' edges resolve; `child.metadata.status`
   * lets `execute` return `{ status: "completed" }` for them without re-running.
   */
  toMissionPlan(tenantId, taskIds = undefined) {
    requireTenant(tenantId);
    let ids = taskIds;
    if (!ids) {
      const closure = new Set();
      const visit = (id) => {
        if (closure.has(id)) return;
        closure.add(id);
        for (const dep of this.dependenciesOf(tenantId, id)) visit(dep);
        for (const child of this.childrenOf(tenantId, id)) visit(child.id);
      };
      this.#store.listTasks(tenantId, { limit: SCAN_LIMIT })
        .filter((task) => !TASK_TERMINAL_STATES.includes(task.status))
        .forEach((task) => visit(task.id));
      ids = [...closure];
    }
    for (const id of ids) this.#requireTask(tenantId, id);
    return this.#waitsForPlan(tenantId, [], ids);
  }

  // -------------------------------------------------------------------------
  // Deadlines
  // -------------------------------------------------------------------------

  setDeadline(tenantId, taskId, deadlineAt) {
    requireTenant(tenantId);
    this.#requireTask(tenantId, taskId);
    const at = new Date(deadlineAt);
    if (Number.isNaN(at.getTime())) throw new OrchestratorError("INVALID_DEADLINE", "A deadline must be a valid timestamp.");
    this.#orch.db.prepare(
      `INSERT INTO task_deadlines (tenant_id, task_id, deadline_at) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, task_id) DO UPDATE SET deadline_at = excluded.deadline_at`,
    ).run(tenantId, taskId, at.toISOString());
    return at.toISOString();
  }

  getDeadline(tenantId, taskId) {
    requireTenant(tenantId);
    return this.#orch.db.prepare("SELECT deadline_at FROM task_deadlines WHERE tenant_id = ? AND task_id = ?").get(tenantId, taskId)?.deadline_at ?? null;
  }

  // -------------------------------------------------------------------------
  // Readiness
  // -------------------------------------------------------------------------

  /**
   * `{ state, ready, waitingOn, unsatisfiable, pendingChildren, deadlineAt, deadlineExceeded }`
   * where state is 'ready' | 'blocked' | 'unsatisfiable' | 'expired' | 'terminal'.
   */
  readiness(tenantId, taskId) {
    const task = this.#requireTask(tenantId, taskId);
    const deadlineAt = this.getDeadline(tenantId, taskId);
    const deadlineExceeded = Boolean(deadlineAt && deadlineAt <= this.#orch.now());
    const waitingOn = [];
    const unsatisfiable = [];
    for (const id of this.dependenciesOf(tenantId, taskId)) {
      const dep = this.#store.getTask(tenantId, id);
      if (!dep || UNSATISFIABLE.has(dep.status)) unsatisfiable.push({ taskId: id, status: dep?.status ?? "missing" });
      else if (dep.status !== SATISFIED) waitingOn.push({ taskId: id, status: dep.status, kind: "dependency" });
    }
    const pendingChildren = this.childrenOf(tenantId, taskId)
      .filter((child) => !TASK_TERMINAL_STATES.includes(child.status))
      .map((child) => ({ taskId: child.id, status: child.status, kind: "child" }));
    let state;
    if (TASK_TERMINAL_STATES.includes(task.status)) state = "terminal";
    else if (deadlineExceeded) state = "expired";
    else if (unsatisfiable.length > 0) state = "unsatisfiable";
    else if (waitingOn.length > 0 || pendingChildren.length > 0) state = "blocked";
    else state = "ready";
    return { taskId, status: task.status, state, ready: state === "ready", waitingOn: [...waitingOn, ...pendingChildren], unsatisfiable, pendingChildren, deadlineAt, deadlineExceeded };
  }

  /** Queued tasks whose dependencies and children are all satisfied. */
  readyTasks(tenantId, { status = "queued" } = {}) {
    return this.#store.listTasks(tenantId, { status, limit: SCAN_LIMIT })
      .filter((task) => this.readiness(tenantId, task.id).ready)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /**
   * Parks a running task whose dependencies or children are not done:
   * running -> waiting_for_dependency. Returns the readiness it acted on.
   */
  waitIfBlocked(tenantId, taskId, { actor = "orchestrator.dag" } = {}) {
    const readiness = this.readiness(tenantId, taskId);
    if (readiness.status === "running" && readiness.state === "blocked") {
      this.#store.transitionTask(tenantId, taskId, "waiting_for_dependency", {
        actor, expectedStatus: "running", reason: `waiting on ${readiness.waitingOn.map((item) => item.taskId).join(", ")}`,
      });
    }
    return readiness;
  }

  /**
   * One DAG sweep for a tenant: waiting tasks that became ready resume
   * running; tasks whose dependencies can never complete fail; tasks past
   * their deadline fail (or are cancelled where failing is not a legal move).
   */
  sweep(tenantId, { actor = "orchestrator.dag" } = {}) {
    const outcome = { resumed: [], failed: [], expired: [] };
    for (const task of this.#store.listTasks(tenantId, { limit: SCAN_LIMIT })) {
      if (TASK_TERMINAL_STATES.includes(task.status)) continue;
      const readiness = this.readiness(tenantId, task.id);
      if (readiness.state === "expired") {
        const to = canTransition(task.status, "failed") ? "failed" : canTransition(task.status, "cancelled") ? "cancelled" : null;
        if (to) {
          this.#store.transitionTask(tenantId, task.id, to, {
            actor, reason: "deadline exceeded", error: { code: "DEADLINE_EXCEEDED", message: `Deadline ${readiness.deadlineAt} passed.`, partial: this.partialResults(tenantId, task.id) },
          });
          outcome.expired.push(task.id);
        }
      } else if (readiness.state === "unsatisfiable" && canTransition(task.status, "failed") && task.status !== "running") {
        this.#store.transitionTask(tenantId, task.id, "failed", {
          actor, reason: "dependency can never complete",
          error: { code: "DEPENDENCY_FAILED", message: "A dependency failed or was cancelled.", dependencies: readiness.unsatisfiable },
        });
        outcome.failed.push(task.id);
      } else if (readiness.state === "ready" && task.status === "waiting_for_dependency") {
        this.#store.transitionTask(tenantId, task.id, "running", { actor, expectedStatus: "waiting_for_dependency", reason: "dependencies satisfied" });
        outcome.resumed.push(task.id);
      }
    }
    return outcome;
  }

  /**
   * What a parent can report while (or after) its children run: each child's
   * and dependency's status and result, and counts, so a partially finished
   * objective is described truthfully instead of as all-or-nothing.
   */
  partialResults(tenantId, taskId) {
    this.#requireTask(tenantId, taskId);
    const describe = (task, relation) => {
      const artifacts = this.#store.listArtifacts(tenantId, { taskId: task.id });
      return {
        taskId: task.id,
        relation,
        objective: task.objective,
        status: task.status,
        result: task.status === "completed" ? task.result : null,
        error: task.error ?? null,
        verifiedArtifacts: artifacts.filter((a) => a.verification === "verified").map((a) => a.id),
      };
    };
    const items = [
      ...this.childrenOf(tenantId, taskId).map((task) => describe(task, "child")),
      ...this.dependenciesOf(tenantId, taskId).map((id) => this.#store.getTask(tenantId, id)).filter(Boolean).map((task) => describe(task, "dependency")),
    ];
    const count = (predicate) => items.filter(predicate).length;
    const summary = {
      total: items.length,
      completed: count((item) => item.status === "completed"),
      failed: count((item) => item.status === "failed"),
      cancelled: count((item) => item.status === "cancelled"),
      pending: count((item) => !TASK_TERMINAL_STATES.includes(item.status)),
    };
    return { taskId, complete: summary.pending === 0 && summary.completed === summary.total, summary, items };
  }
}
