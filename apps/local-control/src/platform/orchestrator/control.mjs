import { TASK_TERMINAL_STATES, canTransition } from "../../../../../packages/atlas-contracts/src/index.mjs";

import { OrchestratorError, requireTenant } from "./store.mjs";

/**
 * Operator control over running work (blueprint §3, §12).
 *
 * Adapters, not a second scheduler or dispatcher: in-process child execution
 * belongs to agent/mission-scheduler.mjs and event delivery to
 * platform/outbox-dispatcher.mjs. This module propagates operator intent into
 * them and adds the durable pieces they lack.
 *
 * - pause/resume set a durable flag on the task and every descendant (the
 *   agent loop checks it before every step) and call `pause()`/`start()` on
 *   any MissionScheduler attached to those tasks. A paused task keeps its
 *   status and checkpoint, so resume continues where it left off.
 * - cancel moves the task and every descendant (by parentTaskId) to
 *   `cancelled`, sets the durable cancel flag (so a loop mid-step stops at its
 *   next check), calls `cancel()` on attached MissionSchedulers (which abort
 *   their running children's signals), and invokes the cancel hooks
 *   registered for live worker sessions (browser, terminal). Hook failures
 *   are reported, never swallowed, and never stop the cancellation.
 * - escalateDeadLetters() turns outbox rows the store dead-lettered after the
 *   OutboxDispatcher's retries into ESCALATION records, once each.
 * - recover() is run at startup: a task left `running`/`verifying` with no
 *   live lease lost its worker. It is moved running -> failed(WORKER_LOST,
 *   recoverable) -> queued so a loop can pick it up from its checkpoint, or,
 *   past `maxRecoveries`, left failed with an ESCALATION for a human.
 */
const SCAN_LIMIT = 100_000;
const ORPHAN_STATES = ["running", "verifying"];
const missionKey = (tenantId, taskId) => `${tenantId}\u0000${taskId}`;

export class TaskControl {
  #store;
  #orch;
  #hooks = new Map();
  #missions = new Map();
  #maxRecoveries;

  constructor({ store, orchestratorStore, maxRecoveries = 2 }) {
    if (!store || !orchestratorStore) throw new OrchestratorError("MISCONFIGURED", "TaskControl needs a task store and an orchestrator store.");
    this.#store = store;
    this.#orch = orchestratorStore;
    this.#maxRecoveries = maxRecoveries;
  }

  #requireTask(tenantId, taskId) {
    requireTenant(tenantId);
    const task = this.#store.getTask(tenantId, taskId);
    if (!task) throw new OrchestratorError("NOT_FOUND", "No such task in this tenant.");
    return task;
  }

  /** Pauses the task and its non-terminal descendants; returns the ids paused. */
  pause(tenantId, taskId, { actor = null, reason = null } = {}) {
    const task = this.#requireTask(tenantId, taskId);
    if (TASK_TERMINAL_STATES.includes(task.status)) throw new OrchestratorError("TASK_TERMINAL", `Task is already '${task.status}'.`);
    const why = reason ?? "paused by operator";
    const paused = [];
    for (const target of [task, ...this.#descendants(tenantId, taskId)]) {
      if (TASK_TERMINAL_STATES.includes(target.status)) continue;
      this.#orch.setControl(tenantId, target.id, { paused: true, actor, reason: why });
      this.#missions.get(missionKey(tenantId, target.id))?.pause(why);
      paused.push(target.id);
    }
    return { paused };
  }

  resume(tenantId, taskId, { actor = null } = {}) {
    const task = this.#requireTask(tenantId, taskId);
    const resumed = [];
    for (const target of [task, ...this.#descendants(tenantId, taskId)]) {
      if (!this.#orch.getControl(tenantId, target.id).paused) continue;
      this.#orch.setControl(tenantId, target.id, { paused: false, actor, reason: null });
      const mission = this.#missions.get(missionKey(tenantId, target.id));
      if (mission?.status === "interrupted") mission.start();
      resumed.push(target.id);
    }
    return { resumed };
  }

  /**
   * Binds a MissionScheduler (agent/mission-scheduler.mjs) that runs a task's
   * child work, so pause/resume/cancel of the task reach it. Returns a
   * detach function.
   */
  attachMission(tenantId, taskId, mission) {
    this.#requireTask(tenantId, taskId);
    if (!mission || typeof mission.pause !== "function" || typeof mission.cancel !== "function" || typeof mission.start !== "function") {
      throw new OrchestratorError("INVALID_MISSION", "attachMission needs a MissionScheduler (pause, cancel, start).");
    }
    const key = missionKey(tenantId, taskId);
    this.#missions.set(key, mission);
    return () => { if (this.#missions.get(key) === mission) this.#missions.delete(key); };
  }

  isPaused(tenantId, taskId) { return this.#orch.getControl(tenantId, taskId).paused; }

  /**
   * Registers a live worker session to stop when its task is cancelled.
   * Returns an unregister function. Hooks are in-memory by nature: a session
   * belongs to this process and does not survive a restart.
   */
  registerWorkerSession(tenantId, taskId, { sessionId, kind, cancel }) {
    requireTenant(tenantId);
    if (typeof cancel !== "function") throw new OrchestratorError("INVALID_HOOK", "A worker session needs a cancel function.");
    const key = `${tenantId}\u0000${taskId}`;
    if (!this.#hooks.has(key)) this.#hooks.set(key, new Map());
    const id = sessionId ?? `session-${this.#hooks.get(key).size + 1}`;
    this.#hooks.get(key).set(id, { sessionId: id, kind: kind ?? "worker", cancel });
    return () => this.#hooks.get(key)?.delete(id);
  }

  #descendants(tenantId, taskId) {
    const all = this.#store.listTasks(tenantId, { limit: SCAN_LIMIT });
    const byParent = new Map();
    for (const task of all) {
      if (!task.parentTaskId) continue;
      if (!byParent.has(task.parentTaskId)) byParent.set(task.parentTaskId, []);
      byParent.get(task.parentTaskId).push(task);
    }
    const out = [];
    const queue = [...(byParent.get(taskId) ?? [])];
    const seen = new Set([taskId]);
    while (queue.length > 0) {
      const task = queue.shift();
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      out.push(task);
      queue.push(...(byParent.get(task.id) ?? []));
    }
    return out;
  }

  /** Cancels a task and all its descendants; returns what was cancelled and each hook's outcome. */
  async cancel(tenantId, taskId, { actor = "operator", reason = "cancelled by operator" } = {}) {
    const root = this.#requireTask(tenantId, taskId);
    const targets = [root, ...this.#descendants(tenantId, taskId)];
    const outcome = { cancelled: [], skipped: [], hooks: [], missions: [] };
    for (const target of targets) {
      const why = target.id === taskId ? reason : `parent ${taskId} cancelled: ${reason}`;
      this.#orch.setControl(tenantId, target.id, { cancelRequested: true, actor, reason: why });
      const current = this.#store.getTask(tenantId, target.id);
      if (canTransition(current.status, "cancelled")) {
        this.#store.transitionTask(tenantId, target.id, "cancelled", { actor, reason: why });
        outcome.cancelled.push(target.id);
      } else {
        outcome.skipped.push({ taskId: target.id, status: current.status });
      }
      this.#orch.releaseLease(tenantId, target.id);
      const mission = this.#missions.get(missionKey(tenantId, target.id));
      if (mission) {
        mission.cancel(why);
        outcome.missions.push({ taskId: target.id, status: mission.status });
        this.#missions.delete(missionKey(tenantId, target.id));
      }
      const sessions = this.#hooks.get(`${tenantId}\u0000${target.id}`);
      for (const session of sessions?.values() ?? []) {
        try {
          await session.cancel({ tenantId, taskId: target.id, reason: why });
          outcome.hooks.push({ taskId: target.id, sessionId: session.sessionId, kind: session.kind, ok: true });
        } catch (error) {
          outcome.hooks.push({ taskId: target.id, sessionId: session.sessionId, kind: session.kind, ok: false, error: String(error?.message ?? error).slice(0, 300) });
        }
      }
      this.#hooks.delete(`${tenantId}\u0000${target.id}`);
    }
    return outcome;
  }

  /**
   * Startup recovery for the given tenants (plus every tenant the
   * orchestrator has state for). Returns `{ requeued, escalated, cancelled }`.
   */
  recover({ tenantIds = [], actor = "orchestrator.recovery" } = {}) {
    const tenants = [...new Set([...tenantIds, ...this.#orch.knownTenants()])];
    const outcome = { requeued: [], escalated: [], cancelled: [] };
    for (const tenantId of tenants) {
      for (const status of ORPHAN_STATES) {
        for (const task of this.#store.listTasks(tenantId, { status, limit: SCAN_LIMIT })) {
          const lease = this.#orch.getLease(tenantId, task.id);
          if (lease?.live) continue;
          this.#orch.releaseLease(tenantId, task.id);
          const control = this.#orch.getControl(tenantId, task.id);
          if (control.cancelRequested) {
            this.#store.transitionTask(tenantId, task.id, "cancelled", { actor, reason: "cancel requested before restart" });
            outcome.cancelled.push(task.id);
            continue;
          }
          const recoveries = control.recoveries + 1;
          this.#orch.setControl(tenantId, task.id, { recoveries });
          const checkpoint = this.#orch.loadCheckpoint(tenantId, task.id);
          const recoverable = recoveries <= this.#maxRecoveries;
          this.#store.transitionTask(tenantId, task.id, "failed", {
            actor, reason: "worker lost: no live lease after restart",
            error: { code: "WORKER_LOST", recoverable, recoveries, fromStatus: status, checkpointStep: checkpoint?.step ?? null },
          });
          if (recoverable) {
            this.#store.transitionTask(tenantId, task.id, "queued", { actor, reason: `re-queued from checkpoint (recovery ${recoveries})` });
            outcome.requeued.push(task.id);
          } else {
            const escalation = this.#orch.createEscalation({
              tenantId, taskId: task.id, correlationId: task.correlationId, source: "recovery", sourceRef: `recovery:${task.id}:${recoveries}`,
              reason: `Task lost its worker ${recoveries} times; a human must decide whether to retry.`,
              details: { recoveries, lastStatus: status, checkpointStep: checkpoint?.step ?? null },
            });
            outcome.escalated.push({ taskId: task.id, escalationId: escalation.id });
          }
        }
      }
    }
    return outcome;
  }

  /**
   * Outbox rows the task store dead-lettered (the OutboxDispatcher's
   * subscribers kept failing) become ESCALATION records, once per row.
   * Returns the escalations opened by this call.
   */
  escalateDeadLetters({ limit = 10_000 } = {}) {
    const opened = [];
    for (const row of this.#store.listOutbox({ status: "dead", limit })) {
      const sourceRef = `outbox:${row.id}`;
      const existed = this.#orch.listEscalations(row.tenantId, { source: "outbox" }).some((e) => e.sourceRef === sourceRef);
      const escalation = this.#orch.createEscalation({
        tenantId: row.tenantId, correlationId: row.correlationId, source: "outbox", sourceRef,
        reason: `Outbox event '${row.topic}' was dead-lettered after ${row.attempts} delivery attempts.`,
        details: { outboxId: row.id, eventId: row.eventId, topic: row.topic, attempts: row.attempts, lastError: row.lastError },
      });
      if (!existed) opened.push(escalation);
    }
    return opened;
  }
}
