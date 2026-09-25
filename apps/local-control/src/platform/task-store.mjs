import { DatabaseSync } from "node:sqlite";

import {
  APPROVAL_STATES,
  BUDGET_DIMENSIONS,
  EVENT_TYPES,
  SCHEMA_VERSION,
  TOOL_CALL_STATES,
  acceptCorrelationId,
  artifactSchema,
  assertSchema,
  assertTransition,
  budgetSchema,
  digest,
  eventSchema,
  newId,
  policyDecisionSchema,
  taskSchema,
  toolCallSchema,
} from "../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Durable control-plane state for Atlas tasks (blueprint Phase 1).
 *
 * Three rules shape this store:
 *
 * - Tenant isolation is structural. Every row carries `tenant_id`, and every
 *   read takes a tenantId and filters on it, so a caller holding tenant B's
 *   credentials cannot read tenant A's task even with a guessed id. A lookup
 *   for another tenant's row is indistinguishable from a missing row.
 * - State changes and the events describing them commit together. Each event
 *   is written to the append-only `events` log and to the transactional
 *   `outbox` in the same transaction as the change, so a crash can never leave
 *   a transition without its audit record or an event for a change that
 *   rolled back.
 * - Records leaving the store are validated against the shared contracts, so
 *   a schema drift fails here rather than in a worker or a dashboard.
 */
export class PlatformStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PlatformStoreError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const DEFAULT_MAX_OUTBOX_ATTEMPTS = 5;

function json(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function parse(text, fallback = null) {
  return text === null || text === undefined ? fallback : JSON.parse(text);
}

function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new PlatformStoreError("TENANT_REQUIRED", "Every platform read and write must name its tenant.");
  }
}

function emptyUsage() {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0]));
}

export class PlatformTaskStore {
  #db;
  #clock;
  #maxOutboxAttempts;
  #txDepth = 0;

  constructor(filename, { clock = () => new Date(), maxOutboxAttempts = DEFAULT_MAX_OUTBOX_ATTEMPTS } = {}) {
    this.#db = new DatabaseSync(filename);
    this.#clock = clock;
    this.#maxOutboxAttempts = maxOutboxAttempts;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT,
        parent_task_id TEXT,
        correlation_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        success_criteria_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_tenant_idx ON tasks(tenant_id, status, created_at);
      CREATE TABLE IF NOT EXISTS task_transitions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        correlation_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        reason TEXT,
        actor TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_transitions_task_idx ON task_transitions(tenant_id, task_id, seq);
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        user_id TEXT NOT NULL,
        agent_id TEXT,
        correlation_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        policy_decision_id TEXT,
        output_json TEXT,
        error_json TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS tool_calls_task_idx ON tool_calls(tenant_id, task_id, created_at);
      CREATE TABLE IF NOT EXISTS policy_decisions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        task_id TEXT,
        tool_call_id TEXT,
        correlation_id TEXT NOT NULL,
        effect TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        tool_call_id TEXT,
        correlation_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT,
        resolved_by TEXT,
        reason TEXT,
        consumed_by TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(tenant_id, task_id, status);
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        tool_call_id TEXT,
        correlation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        media_type TEXT,
        content_json TEXT,
        storage_ref TEXT,
        content_digest TEXT NOT NULL,
        verification TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        verified_at TEXT
      );
      CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts(tenant_id, task_id, created_at);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        type TEXT NOT NULL,
        user_id TEXT,
        agent_id TEXT,
        task_id TEXT,
        correlation_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_tenant_idx ON events(tenant_id, seq);
      CREATE INDEX IF NOT EXISTS events_task_idx ON events(tenant_id, task_id, seq);
      CREATE INDEX IF NOT EXISTS events_correlation_idx ON events(tenant_id, correlation_id, seq);
      -- The event log is append-only: history that can be edited is not an audit trail.
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id),
        correlation_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox(status, id);
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close() {
    this.#db.close();
  }

  #now() {
    return this.#clock().toISOString();
  }

  /**
   * Runs `fn` inside one IMMEDIATE transaction. Nested calls join the outer
   * transaction, so a public method can compose others without splitting the
   * atomic unit. `fn` must be synchronous: node:sqlite is, and an await inside
   * would let another caller interleave with a half-written change.
   */
  transaction(fn) {
    if (this.#txDepth > 0) {
      this.#txDepth += 1;
      try {
        return fn();
      } finally {
        this.#txDepth -= 1;
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#txDepth = 1;
    try {
      const result = fn();
      if (result && typeof result.then === "function") throw new PlatformStoreError("ASYNC_TRANSACTION", "Transactions must be synchronous.");
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#txDepth = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Events and outbox
  // -------------------------------------------------------------------------

  /**
   * Appends one audit event and its outbox row. Always runs inside a
   * transaction so the event commits with whatever change it describes.
   */
  appendEvent({ type, tenantId, correlationId, taskId = null, userId = null, agentId = null, payload = {} }) {
    requireTenant(tenantId);
    if (!EVENT_TYPES.includes(type)) throw new PlatformStoreError("UNKNOWN_EVENT_TYPE", `Unknown event type '${type}'.`);
    const event = assertSchema(eventSchema, {
      schemaVersion: SCHEMA_VERSION,
      id: newId("event"),
      type,
      tenantId,
      userId,
      agentId,
      taskId,
      correlationId,
      payload,
      createdAt: this.#now(),
    }, "event");
    return this.transaction(() => {
      const { lastInsertRowid } = this.#db
        .prepare(
          `INSERT INTO events (id, tenant_id, type, user_id, agent_id, task_id, correlation_id, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(event.id, tenantId, type, userId, agentId, taskId, correlationId, JSON.stringify(payload), event.createdAt);
      this.#db
        .prepare(
          `INSERT INTO outbox (tenant_id, event_id, correlation_id, topic, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(tenantId, event.id, correlationId, type, event.createdAt, event.createdAt);
      return { ...event, seq: Number(lastInsertRowid) };
    });
  }

  /** Events for one tenant, oldest first, each with its global `seq` for resuming. */
  listEvents(tenantId, { taskId = undefined, correlationId = undefined, afterSeq = 0, limit = 500 } = {}) {
    requireTenant(tenantId);
    const clauses = ["tenant_id = ?", "seq > ?"];
    const params = [tenantId, afterSeq];
    if (taskId !== undefined) { clauses.push("task_id = ?"); params.push(taskId); }
    if (correlationId !== undefined) { clauses.push("correlation_id = ?"); params.push(correlationId); }
    params.push(limit);
    return this.#db
      .prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`)
      .all(...params)
      .map((row) => this.#eventFromRow(row));
  }

  #eventFromRow(row) {
    const event = assertSchema(eventSchema, {
      schemaVersion: SCHEMA_VERSION,
      id: row.id,
      type: row.type,
      tenantId: row.tenant_id,
      userId: row.user_id,
      agentId: row.agent_id,
      taskId: row.task_id,
      correlationId: row.correlation_id,
      payload: parse(row.payload_json, {}),
      createdAt: row.created_at,
    }, "event");
    return { ...event, seq: row.seq };
  }

  /**
   * Leases up to `limit` undelivered outbox rows to one dispatcher. A lease
   * that expires (a crashed dispatcher) makes the row claimable again, and a
   * row that has used up its attempts is moved to the dead-letter state
   * rather than retried forever. The outbox is a system-level queue feeding
   * the event bus, so it is deliberately not tenant-filtered; the delivered
   * events themselves carry their tenant.
   */
  claimOutbox(limit, workerId, leaseMs) {
    if (!workerId) throw new PlatformStoreError("WORKER_REQUIRED", "An outbox claim must name its worker.");
    return this.transaction(() => {
      const now = this.#now();
      const leaseExpiresAt = new Date(this.#clock().getTime() + leaseMs).toISOString();
      this.#db
        .prepare(
          `UPDATE outbox SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?,
                  last_error = COALESCE(last_error, 'lease expired after final attempt')
            WHERE status = 'claimed' AND lease_expires_at <= ? AND attempts >= ?`,
        )
        .run(now, now, this.#maxOutboxAttempts);
      const rows = this.#db
        .prepare(
          `SELECT e.*, o.id AS outbox_id, o.attempts AS outbox_attempts FROM outbox o JOIN events e ON e.id = o.event_id
            WHERE o.status = 'pending' OR (o.status = 'claimed' AND o.lease_expires_at <= ?)
            ORDER BY o.id LIMIT ?`,
        )
        .all(now, limit);
      const claim = this.#db.prepare(
        `UPDATE outbox SET status = 'claimed', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?`,
      );
      return rows.map((row) => {
        claim.run(workerId, leaseExpiresAt, now, row.outbox_id);
        return { id: row.outbox_id, attempts: row.outbox_attempts + 1, leaseExpiresAt, event: this.#eventFromRow(row) };
      });
    });
  }

  /** Marks leased rows delivered. Only the current lease holder may ack, when one is named. */
  ackOutbox(ids, workerId = undefined) {
    return this.transaction(() => {
      const now = this.#now();
      let acknowledged = 0;
      for (const id of ids) {
        const result = workerId === undefined
          ? this.#db.prepare("UPDATE outbox SET status = 'delivered', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'claimed'").run(now, id)
          : this.#db.prepare("UPDATE outbox SET status = 'delivered', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'claimed' AND lease_owner = ?").run(now, id, workerId);
        acknowledged += Number(result.changes);
      }
      return acknowledged;
    });
  }

  /** Returns leased rows for retry, or dead-letters them once their attempts are spent. */
  nackOutbox(ids, { error = "delivery failed", workerId = undefined } = {}) {
    return this.transaction(() => {
      const now = this.#now();
      const outcome = { retried: 0, deadLettered: 0 };
      for (const id of ids) {
        const row = this.#db.prepare("SELECT attempts, status, lease_owner FROM outbox WHERE id = ?").get(id);
        if (!row || row.status !== "claimed") continue;
        if (workerId !== undefined && row.lease_owner !== workerId) continue;
        const dead = row.attempts >= this.#maxOutboxAttempts;
        this.#db
          .prepare("UPDATE outbox SET status = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?")
          .run(dead ? "dead" : "pending", String(error).slice(0, 500), now, id);
        if (dead) outcome.deadLettered += 1;
        else outcome.retried += 1;
      }
      return outcome;
    });
  }

  /** Outbox rows by status ('pending', 'claimed', 'delivered', 'dead'), for operators and tests. */
  listOutbox({ status = undefined, limit = 500 } = {}) {
    const rows = status === undefined
      ? this.#db.prepare("SELECT * FROM outbox ORDER BY id LIMIT ?").all(limit)
      : this.#db.prepare("SELECT * FROM outbox WHERE status = ? ORDER BY id LIMIT ?").all(status, limit);
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      eventId: row.event_id,
      correlationId: row.correlation_id,
      topic: row.topic,
      status: row.status,
      attempts: row.attempts,
      leaseOwner: row.lease_owner,
      lastError: row.last_error,
    }));
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  createTask({ tenantId, userId, agentId = null, objective, successCriteria, budget = {}, correlationId = undefined, parentTaskId = null, traceId = null }) {
    requireTenant(tenantId);
    assertSchema(budgetSchema, budget, "budget");
    if (parentTaskId !== null && !this.#taskRow(tenantId, parentTaskId)) {
      throw new PlatformStoreError("NOT_FOUND", "The parent task does not exist in this tenant.");
    }
    const now = this.#now();
    const task = assertSchema(taskSchema, {
      schemaVersion: SCHEMA_VERSION,
      id: newId("task"),
      tenantId,
      userId,
      agentId,
      parentTaskId,
      correlationId: acceptCorrelationId(correlationId),
      traceId,
      objective,
      status: "proposed",
      successCriteria,
      budget,
      usage: emptyUsage(),
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    }, "task");
    return this.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO tasks (id, tenant_id, user_id, agent_id, parent_task_id, correlation_id, objective, status,
                              success_criteria_json, budget_json, usage_json, result_json, error_json, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
        )
        .run(task.id, tenantId, userId, agentId, parentTaskId, task.correlationId, objective, task.status,
          JSON.stringify(successCriteria), JSON.stringify(budget), JSON.stringify(task.usage), now, now);
      this.appendEvent({
        type: "task.created", tenantId, correlationId: task.correlationId, taskId: task.id, userId, agentId,
        payload: { objective, budget, parentTaskId },
      });
      return task;
    });
  }

  #taskRow(tenantId, taskId) {
    requireTenant(tenantId);
    return this.#db.prepare("SELECT * FROM tasks WHERE id = ? AND tenant_id = ?").get(taskId, tenantId) ?? null;
  }

  #requireTaskRow(tenantId, taskId) {
    const row = this.#taskRow(tenantId, taskId);
    if (!row) throw new PlatformStoreError("NOT_FOUND", "No such task in this tenant.");
    return row;
  }

  #taskFromRow(row) {
    return assertSchema(taskSchema, {
      schemaVersion: SCHEMA_VERSION,
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      agentId: row.agent_id,
      parentTaskId: row.parent_task_id,
      correlationId: row.correlation_id,
      traceId: null,
      objective: row.objective,
      status: row.status,
      successCriteria: parse(row.success_criteria_json, []),
      budget: parse(row.budget_json, {}),
      usage: parse(row.usage_json, emptyUsage()),
      result: parse(row.result_json),
      error: parse(row.error_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }, "task");
  }

  getTask(tenantId, taskId) {
    const row = this.#taskRow(tenantId, taskId);
    return row ? this.#taskFromRow(row) : null;
  }

  /** The optimistic-concurrency version of a task; pass it back as `expectedVersion`. */
  getTaskVersion(tenantId, taskId) {
    return this.#taskRow(tenantId, taskId)?.version ?? null;
  }

  listTasks(tenantId, { status = undefined, limit = 100 } = {}) {
    requireTenant(tenantId);
    const rows = status === undefined
      ? this.#db.prepare("SELECT * FROM tasks WHERE tenant_id = ? ORDER BY created_at DESC, id LIMIT ?").all(tenantId, limit)
      : this.#db.prepare("SELECT * FROM tasks WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC, id LIMIT ?").all(tenantId, status, limit);
    return rows.map((row) => this.#taskFromRow(row));
  }

  /**
   * Moves a task through the lifecycle. The transition is checked against
   * the contract state machine, and the UPDATE is conditional on the version
   * read (and on `expectedVersion`/`expectedStatus` when the caller supplies
   * them), so two controllers acting on a stale view cannot both win.
   */
  transitionTask(tenantId, taskId, to, { reason = null, actor = null, expectedVersion = undefined, expectedStatus = undefined, result = undefined, error = undefined } = {}) {
    return this.transaction(() => {
      const row = this.#requireTaskRow(tenantId, taskId);
      if (expectedStatus !== undefined && row.status !== expectedStatus) {
        throw new PlatformStoreError("CONCURRENT_MODIFICATION", `Task is '${row.status}', not the expected '${expectedStatus}'.`);
      }
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        throw new PlatformStoreError("CONCURRENT_MODIFICATION", `Task is at version ${row.version}, not the expected ${expectedVersion}.`);
      }
      assertTransition(row.status, to);
      const now = this.#now();
      const nextVersion = row.version + 1;
      const updated = this.#db
        .prepare(
          `UPDATE tasks SET status = ?, version = ?, updated_at = ?,
                  result_json = COALESCE(?, result_json), error_json = COALESCE(?, error_json)
            WHERE id = ? AND tenant_id = ? AND version = ?`,
        )
        .run(to, nextVersion, now, json(result), json(error), taskId, tenantId, row.version);
      if (Number(updated.changes) !== 1) throw new PlatformStoreError("CONCURRENT_MODIFICATION", "Task changed while transitioning.");
      this.#db
        .prepare(
          `INSERT INTO task_transitions (tenant_id, task_id, correlation_id, from_status, to_status, reason, actor, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(tenantId, taskId, row.correlation_id, row.status, to, reason, actor, nextVersion, now);
      this.appendEvent({
        type: "task.transitioned", tenantId, correlationId: row.correlation_id, taskId, userId: row.user_id, agentId: row.agent_id,
        payload: { from: row.status, to, reason, actor, version: nextVersion },
      });
      return this.#taskFromRow(this.#taskRow(tenantId, taskId));
    });
  }

  listTransitions(tenantId, taskId) {
    requireTenant(tenantId);
    return this.#db
      .prepare("SELECT * FROM task_transitions WHERE tenant_id = ? AND task_id = ? ORDER BY seq")
      .all(tenantId, taskId)
      .map((row) => ({
        seq: row.seq, taskId: row.task_id, tenantId: row.tenant_id, correlationId: row.correlation_id,
        from: row.from_status, to: row.to_status, reason: row.reason, actor: row.actor, version: row.version, createdAt: row.created_at,
      }));
  }

  /** Overwrites the task's persisted usage snapshot (absolute values, not deltas). */
  recordUsage(tenantId, taskId, usage) {
    assertSchema(budgetSchema, usage, "usage");
    return this.transaction(() => {
      const row = this.#requireTaskRow(tenantId, taskId);
      const next = { ...parse(row.usage_json, emptyUsage()), ...usage };
      this.#db.prepare("UPDATE tasks SET usage_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
        .run(JSON.stringify(next), this.#now(), taskId, tenantId);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Tool calls and policy decisions
  // -------------------------------------------------------------------------

  recordToolCall({ tenantId, taskId, userId, agentId = null, tool, input, status = "requested", idempotencyKey, correlationId = undefined, stepId = null }) {
    return this.transaction(() => {
      const task = this.#requireTaskRow(tenantId, taskId);
      const call = assertSchema(toolCallSchema, {
        schemaVersion: SCHEMA_VERSION,
        id: newId("toolCall"),
        taskId,
        stepId,
        tenantId,
        userId,
        agentId,
        correlationId: correlationId ?? task.correlation_id,
        tool,
        input,
        status,
        idempotencyKey,
        policyDecisionId: null,
        output: null,
        error: null,
        durationMs: null,
        createdAt: this.#now(),
        completedAt: null,
      }, "tool call");
      this.#db
        .prepare(
          `INSERT INTO tool_calls (id, tenant_id, task_id, user_id, agent_id, correlation_id, tool, input_json, status,
                                   idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(call.id, tenantId, taskId, userId, agentId, call.correlationId, tool, JSON.stringify(input), status, idempotencyKey, call.createdAt);
      return call;
    });
  }

  updateToolCall(tenantId, toolCallId, { status = undefined, output = undefined, error = undefined, durationMs = undefined, policyDecisionId = undefined, completedAt = undefined } = {}) {
    if (status !== undefined && !TOOL_CALL_STATES.includes(status)) throw new PlatformStoreError("INVALID_STATUS", `Unknown tool call status '${status}'.`);
    return this.transaction(() => {
      const existing = this.getToolCall(tenantId, toolCallId);
      if (!existing) throw new PlatformStoreError("NOT_FOUND", "No such tool call in this tenant.");
      const terminal = status === "succeeded" || status === "failed" || status === "denied";
      const next = {
        ...existing,
        ...(status !== undefined && { status }),
        ...(output !== undefined && { output }),
        ...(error !== undefined && { error }),
        ...(durationMs !== undefined && { durationMs }),
        ...(policyDecisionId !== undefined && { policyDecisionId }),
        completedAt: completedAt ?? (terminal ? this.#now() : existing.completedAt),
      };
      assertSchema(toolCallSchema, next, "tool call");
      this.#db
        .prepare(
          `UPDATE tool_calls SET status = ?, output_json = ?, error_json = ?, duration_ms = ?, policy_decision_id = ?, completed_at = ?
            WHERE id = ? AND tenant_id = ?`,
        )
        .run(next.status, json(next.output), json(next.error), next.durationMs, next.policyDecisionId, next.completedAt, toolCallId, tenantId);
      return next;
    });
  }

  #toolCallFromRow(row) {
    return assertSchema(toolCallSchema, {
      schemaVersion: SCHEMA_VERSION,
      id: row.id,
      taskId: row.task_id,
      stepId: null,
      tenantId: row.tenant_id,
      userId: row.user_id,
      agentId: row.agent_id,
      correlationId: row.correlation_id,
      tool: row.tool,
      input: parse(row.input_json, {}),
      status: row.status,
      idempotencyKey: row.idempotency_key,
      policyDecisionId: row.policy_decision_id,
      output: parse(row.output_json),
      error: parse(row.error_json),
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }, "tool call");
  }

  getToolCall(tenantId, toolCallId) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT * FROM tool_calls WHERE id = ? AND tenant_id = ?").get(toolCallId, tenantId);
    return row ? this.#toolCallFromRow(row) : null;
  }

  getToolCalls(tenantId, taskId) {
    requireTenant(tenantId);
    return this.#db
      .prepare("SELECT * FROM tool_calls WHERE tenant_id = ? AND task_id = ? ORDER BY created_at, rowid")
      .all(tenantId, taskId)
      .map((row) => this.#toolCallFromRow(row));
  }

  recordPolicyDecision(decision, { toolCallId = null, correlationId }) {
    assertSchema(policyDecisionSchema, decision, "policy decision");
    return this.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO policy_decisions (id, tenant_id, task_id, tool_call_id, correlation_id, effect, record_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(decision.id, decision.tenantId, decision.taskId ?? null, toolCallId, correlationId, decision.effect, JSON.stringify(decision), decision.decidedAt);
      return decision;
    });
  }

  getPolicyDecision(tenantId, decisionId) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT record_json FROM policy_decisions WHERE id = ? AND tenant_id = ?").get(decisionId, tenantId);
    return row ? assertSchema(policyDecisionSchema, JSON.parse(row.record_json), "policy decision") : null;
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  /** The stored outcome for an idempotency key, or null. */
  getIdempotency(tenantId, key) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT * FROM idempotency WHERE key = ? AND tenant_id = ?").get(key, tenantId);
    return row ? { key: row.key, taskId: row.task_id, toolCallId: row.tool_call_id, status: row.status, result: parse(row.result_json) } : null;
  }

  /**
   * Claims an idempotency key for an in-flight call. Returns false when the
   * key is already held (in flight or succeeded), which is how a duplicate
   * request racing the original is stopped from executing a second time.
   */
  claimIdempotency({ tenantId, taskId, key, toolCallId }) {
    requireTenant(tenantId);
    const now = this.#now();
    const result = this.#db
      .prepare(
        `INSERT INTO idempotency (key, tenant_id, task_id, tool_call_id, status, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'in_flight', NULL, ?, ?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, tenantId, taskId, toolCallId, now, now);
    return Number(result.changes) === 1;
  }

  completeIdempotency(tenantId, key, result) {
    requireTenant(tenantId);
    this.#db.prepare("UPDATE idempotency SET status = 'succeeded', result_json = ?, updated_at = ? WHERE key = ? AND tenant_id = ?")
      .run(JSON.stringify(result), this.#now(), key, tenantId);
  }

  /** Releases a key whose call failed, so a genuine retry may run. */
  releaseIdempotency(tenantId, key) {
    requireTenant(tenantId);
    this.#db.prepare("DELETE FROM idempotency WHERE key = ? AND tenant_id = ? AND status = 'in_flight'").run(key, tenantId);
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  createApproval({ tenantId, taskId, toolCallId = null, tool, actionDigest, requestedBy = null, expiresAt = null }) {
    return this.transaction(() => {
      const task = this.#requireTaskRow(tenantId, taskId);
      const approval = {
        id: newId("approval"),
        tenantId,
        taskId,
        toolCallId,
        correlationId: task.correlation_id,
        tool,
        actionDigest,
        status: "pending",
        requestedBy,
        resolvedBy: null,
        reason: null,
        consumedBy: null,
        expiresAt,
        createdAt: this.#now(),
        resolvedAt: null,
      };
      this.#db
        .prepare(
          `INSERT INTO approvals (id, tenant_id, task_id, tool_call_id, correlation_id, tool, action_digest, status, requested_by, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(approval.id, tenantId, taskId, toolCallId, task.correlation_id, tool, actionDigest, requestedBy, expiresAt, approval.createdAt);
      this.appendEvent({
        type: "approval.requested", tenantId, correlationId: task.correlation_id, taskId, userId: requestedBy,
        payload: { approvalId: approval.id, tool, actionDigest, toolCallId },
      });
      return approval;
    });
  }

  #approvalFromRow(row) {
    // A pending approval past its deadline reads as expired even before anyone resolves it.
    const expired = row.status === "pending" && row.expires_at && row.expires_at <= this.#now();
    return {
      id: row.id,
      tenantId: row.tenant_id,
      taskId: row.task_id,
      toolCallId: row.tool_call_id,
      correlationId: row.correlation_id,
      tool: row.tool,
      actionDigest: row.action_digest,
      status: expired ? "expired" : row.status,
      requestedBy: row.requested_by,
      resolvedBy: row.resolved_by,
      reason: row.reason,
      consumedBy: row.consumed_by,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  getApproval(tenantId, approvalId) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ? AND tenant_id = ?").get(approvalId, tenantId);
    return row ? this.#approvalFromRow(row) : null;
  }

  listApprovals(tenantId, { taskId = undefined, status = undefined } = {}) {
    requireTenant(tenantId);
    const clauses = ["tenant_id = ?"];
    const params = [tenantId];
    if (taskId !== undefined) { clauses.push("task_id = ?"); params.push(taskId); }
    return this.#db
      .prepare(`SELECT * FROM approvals WHERE ${clauses.join(" AND ")} ORDER BY created_at, rowid`)
      .all(...params)
      .map((row) => this.#approvalFromRow(row))
      .filter((approval) => status === undefined || approval.status === status);
  }

  /** Resolves a pending approval exactly once and records who resolved it. */
  resolveApproval(tenantId, approvalId, { decision, resolvedBy, reason = null }) {
    if (!["approved", "rejected", "expired"].includes(decision) || !APPROVAL_STATES.includes(decision)) {
      throw new PlatformStoreError("INVALID_DECISION", `An approval cannot be resolved as '${decision}'.`);
    }
    if (!resolvedBy) throw new PlatformStoreError("RESOLVER_REQUIRED", "An approval resolution must record who resolved it.");
    return this.transaction(() => {
      const current = this.getApproval(tenantId, approvalId);
      if (!current) throw new PlatformStoreError("NOT_FOUND", "No such approval in this tenant.");
      if (current.status !== "pending" && !(current.status === "expired" && decision === "expired")) {
        throw new PlatformStoreError("ALREADY_RESOLVED", `Approval is already '${current.status}'.`);
      }
      const now = this.#now();
      const updated = this.#db
        .prepare("UPDATE approvals SET status = ?, resolved_by = ?, reason = ?, resolved_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'")
        .run(decision, resolvedBy, reason, now, approvalId, tenantId);
      if (Number(updated.changes) !== 1) throw new PlatformStoreError("ALREADY_RESOLVED", "Approval was resolved concurrently.");
      this.appendEvent({
        type: "approval.resolved", tenantId, correlationId: current.correlationId, taskId: current.taskId, userId: resolvedBy,
        payload: { approvalId, decision, reason, tool: current.tool, actionDigest: current.actionDigest },
      });
      return this.getApproval(tenantId, approvalId);
    });
  }

  /** Spends an approved approval on one tool call; a second spend is refused. */
  consumeApproval(tenantId, approvalId, toolCallId) {
    const result = this.#db
      .prepare("UPDATE approvals SET consumed_by = ? WHERE id = ? AND tenant_id = ? AND status = 'approved' AND consumed_by IS NULL")
      .run(toolCallId, approvalId, tenantId);
    return Number(result.changes) === 1;
  }

  // -------------------------------------------------------------------------
  // Artifacts
  // -------------------------------------------------------------------------

  submitArtifact({ tenantId, taskId, kind, content = null, mediaType = "application/json", storageRef = null, toolCallId = null }) {
    return this.transaction(() => {
      const task = this.#requireTaskRow(tenantId, taskId);
      const artifact = assertSchema(artifactSchema, {
        schemaVersion: SCHEMA_VERSION,
        id: newId("artifact"),
        taskId,
        tenantId,
        toolCallId,
        kind,
        mediaType,
        content,
        storageRef,
        contentDigest: digest(content),
        verification: "unverified",
        verificationEvidence: [],
        createdAt: this.#now(),
      }, "artifact");
      this.#db
        .prepare(
          `INSERT INTO artifacts (id, tenant_id, task_id, tool_call_id, correlation_id, kind, media_type, content_json, storage_ref,
                                  content_digest, verification, evidence_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', '[]', ?)`,
        )
        .run(artifact.id, tenantId, taskId, toolCallId, task.correlation_id, kind, mediaType, JSON.stringify(content), storageRef,
          artifact.contentDigest, artifact.createdAt);
      this.appendEvent({
        type: "artifact.submitted", tenantId, correlationId: task.correlation_id, taskId, userId: task.user_id, agentId: task.agent_id,
        payload: { artifactId: artifact.id, kind, contentDigest: artifact.contentDigest },
      });
      return artifact;
    });
  }

  #artifactFromRow(row) {
    return assertSchema(artifactSchema, {
      schemaVersion: SCHEMA_VERSION,
      id: row.id,
      taskId: row.task_id,
      tenantId: row.tenant_id,
      toolCallId: row.tool_call_id,
      kind: row.kind,
      mediaType: row.media_type,
      content: parse(row.content_json),
      storageRef: row.storage_ref,
      contentDigest: row.content_digest,
      verification: row.verification,
      verificationEvidence: parse(row.evidence_json, []),
      createdAt: row.created_at,
    }, "artifact");
  }

  getArtifact(tenantId, artifactId) {
    requireTenant(tenantId);
    const row = this.#db.prepare("SELECT * FROM artifacts WHERE id = ? AND tenant_id = ?").get(artifactId, tenantId);
    return row ? this.#artifactFromRow(row) : null;
  }

  listArtifacts(tenantId, { taskId = undefined } = {}) {
    requireTenant(tenantId);
    const rows = taskId === undefined
      ? this.#db.prepare("SELECT * FROM artifacts WHERE tenant_id = ? ORDER BY created_at, rowid").all(tenantId)
      : this.#db.prepare("SELECT * FROM artifacts WHERE tenant_id = ? AND task_id = ? ORDER BY created_at, rowid").all(tenantId, taskId);
    return rows.map((row) => this.#artifactFromRow(row));
  }

  /**
   * Records the outcome of a deterministic check. Verification is terminal:
   * an artifact that was verified or rejected is not re-judged in place — a
   * corrected artifact is a new submission with its own digest.
   */
  markArtifactVerified(tenantId, artifactId, { verified, evidence }) {
    if (!Array.isArray(evidence) || evidence.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new PlatformStoreError("INVALID_EVIDENCE", "Verification evidence must be a list of structured objects.");
    }
    if (verified && evidence.length === 0) {
      throw new PlatformStoreError("EVIDENCE_REQUIRED", "An artifact cannot be marked verified without evidence.");
    }
    return this.transaction(() => {
      const current = this.getArtifact(tenantId, artifactId);
      if (!current) throw new PlatformStoreError("NOT_FOUND", "No such artifact in this tenant.");
      if (current.verification !== "unverified") throw new PlatformStoreError("ALREADY_VERIFIED", `Artifact is already '${current.verification}'.`);
      const verification = verified ? "verified" : "rejected";
      this.#db
        .prepare("UPDATE artifacts SET verification = ?, evidence_json = ?, verified_at = ? WHERE id = ? AND tenant_id = ?")
        .run(verification, JSON.stringify(evidence), this.#now(), artifactId, tenantId);
      const task = this.#requireTaskRow(tenantId, current.taskId);
      this.appendEvent({
        type: "artifact.verified", tenantId, correlationId: task.correlation_id, taskId: current.taskId, userId: task.user_id, agentId: task.agent_id,
        payload: { artifactId, verification, contentDigest: current.contentDigest, evidenceCount: evidence.length },
      });
      return this.getArtifact(tenantId, artifactId);
    });
  }
}
