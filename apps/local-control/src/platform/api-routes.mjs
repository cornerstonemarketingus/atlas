import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVAL_STATES,
  BUDGET_DIMENSIONS,
  TASK_TERMINAL_STATES,
  budgetSchema,
  canTransition,
  digest,
  validateSchema,
} from "../../../../packages/atlas-contracts/src/index.mjs";
import { FamilyError, TaskDelegation } from "./family/index.mjs";
import { buildRunManifest, replayManifest, runSuite } from "./evals/index.mjs";
import { redactSecrets } from "./memory/redaction.mjs";

/**
 * The authenticated, versioned write+read API of the platform control plane
 * (blueprint §16 and §18), mounted under /v1/platform/.
 *
 * Rules every route follows:
 *
 * - Only the local owner (identity.role === "admin") may change anything.
 *   Paired devices get the read routes and a 403 on every write, whatever the
 *   body says.
 * - Every body is size-limited, must be JSON, and is validated against a
 *   closed schema (unknown properties are refused) before any store is
 *   touched. Malformed JSON is 400, a schema violation is 422, an oversize
 *   body is 413.
 * - The tenant is derived from the identity, never from the request, so the
 *   same routes serve a multi-tenant store once identity carries a tenant.
 * - Store and graph errors map to stable status codes (404 missing, 409
 *   illegal state, 403 refused by policy, 422 refused by caps/validation), and
 *   their messages are passed on because they are written for operators.
 *
 * The read-only task list and task detail stay in dashboard.mjs; this module
 * answers every other /v1/platform/ path and returns false for those, so the
 * dashboard's own behaviour is unchanged.
 */

export const LOCAL_TENANT_ID = "local";
export const OWNER_USER_ID = "owner";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_TASK_SCAN = 5000;

const TASK_ID = "tsk_[0-9a-f]{32}";
const AGENT_ID = "agt_[0-9a-f]{32}";
const APPROVAL_ID = "apr_[0-9a-f]{32}";
const MEMORY_ID = "mem_[0-9a-f]{32}";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/u;

/** States a task is doing (or about to do) work in: what an emergency stop halts. */
const IN_FLIGHT_STATES = Object.freeze(["authorized", "queued", "running", "waiting_for_dependency", "waiting_for_approval", "verifying"]);
/** Transitions the owner may request through the API; the rest belong to the orchestrator. */
const OWNER_TRANSITIONS = Object.freeze(["authorized", "queued"]);

// ---------------------------------------------------------------------------
// Body schemas (closed: additionalProperties false everywhere)
// ---------------------------------------------------------------------------

const text = (max, min = 1) => ({ type: "string", minLength: min, maxLength: max });
const reasonSchema = text(500);
const criteriaSchema = { type: "array", minItems: 1, maxItems: 32, items: text(1000) };
const agentIdSchema = { type: "string", pattern: `^${AGENT_ID}$` };
const permissionsSchema = { type: "array", maxItems: 256, items: { type: "string", minLength: 1, maxLength: 128, pattern: "^(\\*|[a-z][a-z0-9_]*(\\.([a-z][a-z0-9_]*|\\*))*)$" } };
const scopeSchema = { type: "object" };

const BENCHMARKS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "benchmarks");

export const API_SCHEMAS = Object.freeze({
  evalRun: { type: "object", additionalProperties: false, properties: { candidate: { type: "string", pattern: "^[a-z][a-z0-9-]{0,40}$" } } },
  createTask: {
    type: "object", additionalProperties: false, required: ["objective", "successCriteria", "budget"],
    properties: {
      objective: text(8000),
      successCriteria: criteriaSchema,
      budget: budgetSchema,
      agentId: agentIdSchema,
    },
  },
  transition: {
    type: "object", additionalProperties: false, required: ["to"],
    properties: { to: { enum: OWNER_TRANSITIONS }, reason: reasonSchema, expectedVersion: { type: "integer", minimum: 1 } },
  },
  cancel: { type: "object", additionalProperties: false, properties: { reason: reasonSchema } },
  decision: {
    type: "object", additionalProperties: false, required: ["decision"],
    properties: { decision: { enum: ["approve", "reject"] }, reason: reasonSchema },
  },
  proposeAgent: {
    type: "object", additionalProperties: false, required: ["role", "family", "permissions"],
    properties: {
      parentId: { type: ["string", "null"], pattern: `^${AGENT_ID}$` },
      role: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" },
      family: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" },
      name: text(200),
      permissions: permissionsSchema,
      budget: budgetSchema,
      persistent: { type: "boolean" },
      taskId: { type: "string", pattern: `^${TASK_ID}$` },
    },
  },
  authorizeAgent: { type: "object", additionalProperties: false, properties: { reason: reasonSchema } },
  delegate: {
    type: "object", additionalProperties: false, required: ["fromAgentId", "toAgentId", "objective", "successCriteria"],
    properties: {
      fromAgentId: agentIdSchema, toAgentId: agentIdSchema, objective: text(8000), successCriteria: criteriaSchema, budget: budgetSchema,
    },
  },
  crossFamilyHelp: {
    type: "object", additionalProperties: false, required: ["fromAgentId", "scope"],
    properties: {
      fromAgentId: agentIdSchema,
      toFamily: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" },
      toAgentId: agentIdSchema,
      scope: scopeSchema,
      objective: text(8000),
      successCriteria: criteriaSchema,
    },
  },
  writeMemory: {
    type: "object", additionalProperties: false, required: ["content"],
    properties: {
      content: text(16_384),
      scope: { enum: ["task", "agent", "family", "project", "user", "organization"] },
      scopeRef: text(200),
      kind: { enum: ["observation", "hypothesis"] },
      source: text(200),
      sourceRefs: { type: "array", maxItems: 32, items: text(200) },
      retentionDays: { type: "integer", minimum: 1, maximum: 36_500 },
    },
  },
  correctMemory: {
    type: "object", additionalProperties: false, required: ["content", "reason"],
    properties: { content: text(16_384), reason: reasonSchema },
  },
  emergencyStop: {
    type: "object", additionalProperties: false, required: ["confirm"],
    properties: { confirm: { const: true }, reason: reasonSchema },
  },
});

// ---------------------------------------------------------------------------
// Worker probes
// ---------------------------------------------------------------------------

/**
 * Reports whether the browser worker could start on this machine without
 * importing it: importing would launch nothing, but it would load Playwright
 * into the control plane's process, which is exactly what the worker split
 * exists to avoid.
 */
export function probeBrowserWorker() {
  const bases = [new URL("../../../browser-worker/package.json", import.meta.url), import.meta.url];
  for (const base of bases) {
    try {
      const path = createRequire(base).resolve("playwright-core");
      const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || null;
      return {
        available: true,
        playwrightCore: path,
        browsersPath,
        browsersInstalled: browsersPath ? existsSync(browsersPath) : null,
      };
    } catch {
      // Try the next base.
    }
  }
  return { available: false, reason: "playwright-core is not installed; run npm install in apps/browser-worker." };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createPlatformApiRoutes({
  store,
  family = null,
  delegation = undefined,
  memory = null,
  terminal = null,
  mcp = null,
  audit = () => {},
  tenantFor = () => LOCAL_TENANT_ID,
  browserProbe = probeBrowserWorker,
  onEmergencyStop = null,
  // Replay and evaluation: `tools()` lists the live executor's tool definitions (so a manifest describes them
  // exactly), `policy` is the engine replay asks "would today's policy still allow this?", `runtime` is
  // recorded in each manifest, `benchmarks` is the suite directory.
  evals = {},
}) {
  if (!store) throw new TypeError("store is required.");
  const tasks = delegation ?? (family ? new TaskDelegation(family) : null);

  const routes = [
    ["GET", "/whoami", whoami],
    ["POST", "/tasks", createTask],
    ["POST", `/tasks/(${TASK_ID})/transitions`, transitionTask],
    ["POST", `/tasks/(${TASK_ID})/cancel`, cancelTask],
    ["GET", `/tasks/(${TASK_ID})/artifacts`, listArtifacts],
    ["GET", `/tasks/(${TASK_ID})/timeline`, timeline],
    ["GET", `/tasks/(${TASK_ID})/blockers`, blockers],
    ["GET", `/tasks/(${TASK_ID})/manifest`, manifest],
    ["POST", `/tasks/(${TASK_ID})/replay`, replay],
    ["GET", "/evals/suite", evalSuite],
    ["POST", "/evals/run", evalRun],
    ["POST", `/tasks/(${TASK_ID})/delegate`, delegate],
    ["POST", `/tasks/(${TASK_ID})/cross-family-help`, crossFamilyHelp],
    ["GET", "/approvals", listApprovals],
    ["POST", `/approvals/(${APPROVAL_ID})/decision`, decideApproval],
    ["GET", "/family", familyTree],
    ["POST", "/agents", proposeAgent],
    ["POST", `/agents/(${AGENT_ID})/authorize`, authorizeAgent],
    ["GET", "/memory", searchMemory],
    ["POST", "/memory", writeMemory],
    ["GET", "/memory/export", exportMemory],
    ["POST", `/memory/(${MEMORY_ID})/correct`, correctMemory],
    ["DELETE", `/memory/(${MEMORY_ID})`, deleteMemory],
    ["GET", "/costs", costs],
    ["GET", "/workers", workers],
    ["POST", "/emergency-stop", emergencyStop],
  ].map(([method, pattern, handler]) => ({ method, pattern: new RegExp(`^/v1/platform${pattern}$`, "u"), handler }));

  /**
   * Handles a /v1/platform/ request this module owns. Resolves to false for
   * paths it does not know, so the caller can fall through to the dashboard.
   */
  async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/platform/")) return false;
    const matching = routes.filter((route) => route.pattern.test(url.pathname));
    if (matching.length === 0) return false;
    const route = matching.find((candidate) => candidate.method === request.method);
    if (!route) {
      // The dashboard owns GET on these paths (the task list); anything else is a wrong method.
      if (request.method === "GET") return false;
      response.setHeader("allow", [...new Set(matching.map((m) => m.method))].join(", "));
      return send(response, 405, { message: `Method ${request.method} is not allowed here.` });
    }
    if (route.method !== "GET" && identity?.role !== "admin") {
      return send(response, 403, { message: "Only the local owner can change platform state; paired devices are read-only." });
    }
    const context = {
      request, response, identity, url,
      params: route.pattern.exec(url.pathname).slice(1),
      tenantId: tenantFor(identity),
      actor: identity?.role === "admin" ? OWNER_USER_ID : `device:${identity?.device?.id ?? "unknown"}`,
    };
    try {
      await route.handler(context);
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
    }
    return true;
  }

  // -- helpers -------------------------------------------------------------

  async function body(context, schema) {
    const { request } = context;
    const raw = await readBody(request);
    let value = {};
    if (raw.length > 0) {
      const type = String(request.headers["content-type"] ?? "");
      if (!/^application\/json\b/iu.test(type)) throw new ApiError(415, "Request bodies must be application/json.");
      try { value = JSON.parse(raw); } catch { throw new ApiError(400, "Request body is not valid JSON."); }
    }
    const errors = validateSchema(schema, value);
    if (errors.length) throw new ApiError(422, `Invalid request: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}.`, { errors });
    return value;
  }

  function requireTask(context, taskId = context.params[0]) {
    const task = store.getTask(context.tenantId, taskId);
    if (!task) throw new ApiError(404, "Task not found.");
    return task;
  }

  function requireFamily() {
    if (!family || !tasks) throw new ApiError(503, "The agent family registry is not running in this process.");
    return family;
  }

  function requireMemory() {
    if (!memory) throw new ApiError(503, "The memory store is not running in this process.");
    return memory;
  }

  function allTasks(tenantId) {
    return store.listTasks(tenantId, { limit: MAX_TASK_SCAN });
  }

  /** The task and every descendant task (by parentTaskId), parents first. */
  function withDescendants(tenantId, rootId) {
    const everything = allTasks(tenantId);
    const byParent = new Map();
    for (const task of everything) {
      if (!task.parentTaskId) continue;
      if (!byParent.has(task.parentTaskId)) byParent.set(task.parentTaskId, []);
      byParent.get(task.parentTaskId).push(task);
    }
    const out = [];
    const seen = new Set();
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      for (const child of byParent.get(id) ?? []) queue.push(child.id);
    }
    return out;
  }

  /** Cancels one task if it can still be cancelled, and rejects what it was waiting on. */
  function cancelOne(tenantId, taskId, { reason, actor }) {
    const task = store.getTask(tenantId, taskId);
    if (!task || !canTransition(task.status, "cancelled")) return null;
    const cancelled = store.transitionTask(tenantId, taskId, "cancelled", { reason, actor, expectedStatus: task.status });
    const rejected = [];
    for (const approval of store.listApprovals(tenantId, { taskId, status: "pending" })) {
      rejected.push(store.resolveApproval(tenantId, approval.id, { decision: "rejected", resolvedBy: actor, reason: `task cancelled: ${reason}` }).id);
    }
    return { task: cancelled, rejectedApprovals: rejected };
  }

  function cancelDelegation(tenantId, taskId, actor, reason) {
    if (!tasks) return [];
    try {
      if (!tasks.getAssignment(tenantId, taskId)) return [];
      return tasks.cancelTask(tenantId, taskId, { reason: `${reason} (by ${actor})` }).map((assignment) => assignment.taskId);
    } catch {
      return [];
    }
  }

  function auditSafe(category, summary) {
    try { audit(category, summary); } catch { /* Audit sinks must never break the action they describe. */ }
  }

  // -- identity ------------------------------------------------------------

  function whoami({ response, identity, tenantId }) {
    return send(response, 200, { role: identity?.role ?? "unknown", canWrite: identity?.role === "admin", tenantId });
  }

  // -- tasks ---------------------------------------------------------------

  async function createTask(context) {
    const { request, response, tenantId, actor } = context;
    const headerKey = request.headers["idempotency-key"];
    if (headerKey !== undefined && (typeof headerKey !== "string" || !IDEMPOTENCY_KEY.test(headerKey))) {
      throw new ApiError(400, "Idempotency-Key must be 8–128 characters of letters, digits, '_', '.', ':' or '-'.");
    }
    const input = await body(context, API_SCHEMAS.createTask);
    const requestDigest = digest(input);
    const storedKey = headerKey ? `api:${tenantId}:create_task:${headerKey}` : null;
    const outcome = store.transaction(() => {
      if (storedKey) {
        const existing = store.getIdempotency(tenantId, storedKey);
        if (existing) {
          if (existing.result?.requestDigest !== requestDigest) {
            throw new ApiError(422, "This Idempotency-Key was already used for a different request.");
          }
          return { task: store.getTask(tenantId, existing.taskId), replayed: true };
        }
      }
      const task = store.createTask({
        tenantId, userId: actor, agentId: input.agentId ?? null,
        objective: input.objective, successCriteria: input.successCriteria, budget: input.budget,
      });
      if (storedKey) {
        store.claimIdempotency({ tenantId, taskId: task.id, key: storedKey, toolCallId: "api.create_task" });
        store.completeIdempotency(tenantId, storedKey, { taskId: task.id, requestDigest });
      }
      return { task, replayed: false };
    });
    if (outcome.replayed) response.setHeader("idempotent-replay", "true");
    else auditSafe("platform.task.created", `${outcome.task.id}: ${outcome.task.objective.slice(0, 200)}`);
    return send(response, outcome.replayed ? 200 : 201, { task: outcome.task, replayed: outcome.replayed });
  }

  async function transitionTask(context) {
    const { response, tenantId, actor } = context;
    const input = await body(context, API_SCHEMAS.transition);
    const current = requireTask(context);
    const task = store.transitionTask(tenantId, current.id, input.to, {
      reason: input.reason ?? `owner requested ${input.to}`, actor,
      expectedStatus: current.status,
      ...(input.expectedVersion !== undefined && { expectedVersion: input.expectedVersion }),
    });
    auditSafe("platform.task.transitioned", `${task.id}: ${current.status} -> ${task.status}`);
    return send(response, 200, { task });
  }

  async function cancelTask(context) {
    const { response, tenantId, actor } = context;
    const input = await body(context, API_SCHEMAS.cancel);
    const root = requireTask(context);
    if (!canTransition(root.status, "cancelled")) throw new ApiError(409, `Task is '${root.status}' and can no longer be cancelled.`);
    const reason = input.reason ?? "cancelled by owner";
    const result = store.transaction(() => {
      const cancelled = [];
      const rejectedApprovals = [];
      for (const id of withDescendants(tenantId, root.id)) {
        const outcome = cancelOne(tenantId, id, { reason: id === root.id ? reason : `parent ${root.id} cancelled`, actor });
        if (outcome) {
          cancelled.push(id);
          rejectedApprovals.push(...outcome.rejectedApprovals);
        }
      }
      return { cancelled, rejectedApprovals };
    });
    const assignments = cancelDelegation(tenantId, root.id, actor, reason);
    auditSafe("platform.task.cancelled", `${root.id} and ${result.cancelled.length - 1} descendant task(s): ${reason}`);
    return send(response, 200, { task: store.getTask(tenantId, root.id), ...result, cancelledAssignments: assignments });
  }

  /** The mission as a versioned, redacted manifest: what a replay or an evaluation consumes. */
  function manifest(context) {
    const task = requireTask(context);
    return send(context.response, 200, { manifest: buildRunManifest({ store, tenantId: context.tenantId, taskId: task.id, tools: evals.tools ? evals.tools() : null, runtime: evals.runtime ?? {} }) });
  }

  /**
   * Replays a mission without side effects (owner only: it costs compute, not
   * safety). The environment contains stub tools that serve recorded results
   * and nothing else, so no recorded action can be repeated.
   */
  async function replay(context) {
    const task = requireTask(context);
    const recorded = buildRunManifest({ store, tenantId: context.tenantId, taskId: task.id, tools: evals.tools ? evals.tools() : null, runtime: evals.runtime ?? {} });
    const outcome = await replayManifest({ manifest: recorded, policy: evals.policy ?? null });
    auditSafe("platform.task.replayed", `${task.id}: ${outcome.comparison.regressions.join(", ") || "identical"}`);
    return send(context.response, 200, { baselineDigest: recorded.manifestDigest, replayDigest: outcome.replay.manifestDigest, comparison: outcome.comparison, safety: outcome.safety, loop: outcome.loop });
  }

  function benchmarkFile(name) {
    try { return JSON.parse(readFileSync(join(evals.benchmarks ?? BENCHMARKS, name), "utf8")); } catch { throw new ApiError(503, "The benchmark suite is not installed in this build."); }
  }

  function evalSuite(context) {
    const suite = benchmarkFile("core.v1.json");
    const gate = benchmarkFile("release-gate.v1.json");
    return send(context.response, 200, {
      suite: { id: suite.id, version: suite.version, scenarios: suite.scenarios.map((scenario) => ({ id: scenario.id, category: scenario.category, title: scenario.title, candidates: Object.keys(scenario.candidates) })) },
      gate: { version: gate.version, rules: gate.rules },
    });
  }

  /** Runs the versioned suite against a named scripted candidate and says whether the release gate would accept it. */
  async function evalRun(context) {
    const input = await body(context, API_SCHEMAS.evalRun);
    const outcome = await runSuite({ suite: benchmarkFile("core.v1.json"), candidate: input.candidate ?? "reference", thresholds: benchmarkFile("release-gate.v1.json"), baseline: benchmarkFile("baseline.core.v1.json").summary });
    auditSafe("platform.evals.run", `${outcome.candidate}: ${outcome.gate.pass ? "gate passed" : `gate rejected (${outcome.gate.violations.map((v) => v.rule).join(", ")})`}`);
    const { perScenario, ...summary } = outcome.summary;
    return send(context.response, 200, { suite: outcome.suite, candidate: outcome.candidate, summary, scenarios: outcome.results.map((result) => ({ id: result.scenarioId, status: result.manifest.outcome.status, met: result.expectations.met, failures: result.expectations.failures, replayIdentical: result.replay?.identical ?? null })), gate: outcome.gate });
  }

  function listArtifacts(context) {
    const task = requireTask(context);
    return send(context.response, 200, { artifacts: store.listArtifacts(context.tenantId, { taskId: task.id }).map(withoutBulkyContent) });
  }

  /**
   * Replay view: transitions, tool calls, approvals, artifacts and events of
   * one task in order. Tool inputs and outputs are scrubbed of secret-named
   * fields and secret-shaped strings, so a replay can be shared.
   */
  function timeline(context) {
    const { tenantId, response } = context;
    const task = requireTask(context);
    const entries = [];
    for (const transition of store.listTransitions(tenantId, task.id)) {
      entries.push({ at: transition.createdAt, kind: "transition", order: 0, seq: transition.seq, from: transition.from, to: transition.to, reason: transition.reason, actor: transition.actor });
    }
    for (const call of store.getToolCalls(tenantId, task.id)) {
      const decision = call.policyDecisionId ? store.getPolicyDecision(tenantId, call.policyDecisionId) : null;
      entries.push({
        at: call.createdAt, kind: "tool_call", order: 1, id: call.id, tool: call.tool, status: call.status,
        input: call.input, output: call.output, error: call.error, durationMs: call.durationMs, completedAt: call.completedAt,
        decision: decision ? { effect: decision.effect, reasons: decision.reasons, policyVersion: decision.policyVersion } : null,
      });
    }
    for (const event of store.listEvents(tenantId, { taskId: task.id, limit: 2000 })) {
      entries.push({ at: event.createdAt, kind: "event", order: 2, seq: event.seq, type: event.type, payload: event.payload });
    }
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || (a.seq ?? 0) - (b.seq ?? 0)));
    const summary = { id: task.id, objective: task.objective, status: task.status, correlationId: task.correlationId, usage: task.usage, budget: task.budget };
    return send(response, 200, scrub({ task: summary, entries: entries.map(({ order, ...entry }) => entry) }));
  }

  /** Why a task is not moving: pending approvals and unfinished dependencies. */
  function blockers(context) {
    const { tenantId, response } = context;
    const task = requireTask(context);
    const approvals = store.listApprovals(tenantId, { taskId: task.id, status: "pending" })
      .map(({ id, tool, requestedBy, createdAt, expiresAt }) => ({ id, tool, requestedBy, createdAt, expiresAt }));
    const dependencies = allTasks(tenantId)
      .filter((child) => child.parentTaskId === task.id && child.status !== "completed" && child.status !== "archived")
      .map(({ id, objective, status, agentId }) => ({ id, objective, status, agentId }));
    let delegated = null;
    if (tasks) {
      try {
        const assignment = tasks.getAssignment(tenantId, task.id);
        if (assignment?.state === "waiting_for_dependency") delegated = tasks.dependencyStatus(tenantId, task.id);
      } catch { delegated = null; }
    }
    let reason = null;
    if (task.status === "waiting_for_approval") {
      reason = approvals.length
        ? `Waiting for approval of ${approvals.map((a) => a.tool).join(", ")}.`
        : "Waiting for approval, but no approval is pending; the orchestrator must re-request or fail it.";
    } else if (task.status === "waiting_for_dependency") {
      const pending = delegated?.pending?.length ? delegated.pending : dependencies.map((d) => d.id);
      reason = pending.length ? `Waiting for ${pending.length} dependency task(s): ${pending.join(", ")}.` : "Waiting for a dependency that has not been recorded.";
    } else if (task.status === "proposed") {
      reason = "Proposed: the owner has not authorized it yet.";
    } else if (task.status === "authorized") {
      reason = "Authorized: not queued yet.";
    }
    return send(response, 200, { taskId: task.id, status: task.status, blocked: reason !== null, reason, approvals, dependencies, delegated });
  }

  async function delegate(context) {
    const { tenantId, response, actor } = context;
    const registry = requireFamily();
    const input = await body(context, API_SCHEMAS.delegate);
    const parent = requireTask(context);
    if (TASK_TERMINAL_STATES.includes(parent.status)) throw new ApiError(409, `Task is '${parent.status}'; nothing can be delegated from it.`);
    const outcome = store.transaction(() => {
      const child = store.createTask({
        tenantId, userId: actor, agentId: input.toAgentId, parentTaskId: parent.id, correlationId: parent.correlationId,
        objective: input.objective, successCriteria: input.successCriteria, budget: input.budget ?? {},
      });
      const delegated = registry.transaction(() => {
        if (!tasks.getAssignment(tenantId, parent.id)) {
          tasks.assignTask({ tenantId, agentId: input.fromAgentId, taskId: parent.id, correlationId: parent.correlationId, payload: { objective: parent.objective.slice(0, 500) } });
        }
        return tasks.delegateTask({
          tenantId, fromAgentId: input.fromAgentId, toAgentId: input.toAgentId, taskId: child.id, parentTaskId: parent.id,
          correlationId: parent.correlationId, payload: { objective: input.objective.slice(0, 500) },
        });
      });
      return { task: child, assignment: delegated.assignment, message: delegated.message };
    });
    auditSafe("platform.task.delegated", `${parent.id} -> ${outcome.task.id} (${input.fromAgentId} -> ${input.toAgentId})`);
    return send(response, 201, outcome);
  }

  async function crossFamilyHelp(context) {
    const { tenantId, response, actor } = context;
    const registry = requireFamily();
    const input = await body(context, API_SCHEMAS.crossFamilyHelp);
    if (!input.toFamily && !input.toAgentId) throw new ApiError(422, "Name the helper with toFamily or toAgentId.");
    const parent = requireTask(context);
    if (TASK_TERMINAL_STATES.includes(parent.status)) throw new ApiError(409, `Task is '${parent.status}'; it cannot ask for help.`);
    const outcome = store.transaction(() => {
      const child = store.createTask({
        tenantId, userId: actor, agentId: null, parentTaskId: parent.id, correlationId: parent.correlationId,
        objective: input.objective ?? `Cross-family help for ${parent.id}`,
        successCriteria: input.successCriteria ?? ["The requested scope is answered with verified evidence."],
        budget: {},
      });
      const request = registry.transaction(() => {
        if (!tasks.getAssignment(tenantId, parent.id)) {
          tasks.assignTask({ tenantId, agentId: input.fromAgentId, taskId: parent.id, correlationId: parent.correlationId, payload: { objective: parent.objective.slice(0, 500) } });
        }
        return tasks.requestCrossFamilyHelp({
          tenantId, fromAgentId: input.fromAgentId, toFamily: input.toFamily, toAgentId: input.toAgentId,
          taskId: parent.id, subtaskId: child.id, scope: input.scope, correlationId: parent.correlationId,
        });
      });
      return { task: child, requestId: request.requestId, helper: summarizeAgent(request.helper), assignment: request.assignment };
    });
    auditSafe("platform.task.cross_family_help", `${parent.id} -> ${outcome.task.id} (${outcome.helper.family})`);
    return send(response, 201, outcome);
  }

  // -- approvals -----------------------------------------------------------

  function listApprovals(context) {
    const { url, tenantId, response } = context;
    const status = url.searchParams.get("status") || undefined;
    if (status !== undefined && !APPROVAL_STATES.includes(status)) throw new ApiError(422, `status must be one of ${APPROVAL_STATES.join(", ")}.`);
    const objectives = new Map();
    const approvals = store.listApprovals(tenantId, { status }).map((approval) => {
      if (!objectives.has(approval.taskId)) {
        const task = store.getTask(tenantId, approval.taskId);
        objectives.set(approval.taskId, task ? { objective: task.objective, status: task.status } : null);
      }
      return { ...approval, task: objectives.get(approval.taskId) };
    });
    return send(response, 200, { approvals });
  }

  async function decideApproval(context) {
    const { tenantId, response, actor } = context;
    const input = await body(context, API_SCHEMAS.decision);
    const decision = input.decision === "approve" ? "approved" : "rejected";
    const approval = store.transaction(() => {
      const resolved = store.resolveApproval(tenantId, context.params[0], { decision, resolvedBy: actor, reason: input.reason ?? null });
      // A rejected action ends the task that was blocked on it; an approved
      // one is resumed by whichever worker holds the task, with this approval.
      if (decision === "rejected") {
        const task = store.getTask(tenantId, resolved.taskId);
        if (task?.status === "waiting_for_approval") {
          store.transitionTask(tenantId, task.id, "failed", {
            reason: `approval ${resolved.id} rejected`, actor, expectedStatus: "waiting_for_approval",
            error: { code: "APPROVAL_REJECTED", message: input.reason ?? `The owner rejected ${resolved.tool}.` },
          });
        }
      }
      return resolved;
    });
    auditSafe("platform.approval.decided", `${approval.id} (${approval.tool}) = ${decision}`);
    return send(response, 200, { approval, task: store.getTask(tenantId, approval.taskId) });
  }

  // -- family --------------------------------------------------------------

  function familyTree(context) {
    const { tenantId, response } = context;
    const registry = requireFamily();
    const agents = registry.listAgents(tenantId);
    const trees = agents.filter((agent) => agent.parentId === null).map((root) => registry.familyTree(tenantId, root.id));
    const counts = {};
    for (const agent of agents) counts[agent.state] = (counts[agent.state] ?? 0) + 1;
    return send(response, 200, {
      trees,
      counts,
      proposed: agents.filter((agent) => agent.state === "proposed").map(summarizeAgent),
      caps: registry.getTenantCaps(tenantId),
      crossFamilyRequests: tasks.listCrossFamilyRequests(tenantId),
    });
  }

  async function proposeAgent(context) {
    const { tenantId, response, actor } = context;
    const registry = requireFamily();
    const input = await body(context, API_SCHEMAS.proposeAgent);
    const agent = registry.proposeAgent({
      tenantId, parentId: input.parentId ?? null, role: input.role, family: input.family, name: input.name,
      permissions: input.permissions, persistent: input.persistent ?? false, budget: input.budget ?? {},
      requestedBy: actor, taskId: input.taskId ?? null,
    });
    auditSafe("platform.agent.proposed", `${agent.id} ${agent.family}/${agent.role} [${agent.permissions.join(", ")}]`);
    return send(response, 201, { agent });
  }

  async function authorizeAgent(context) {
    const { tenantId, response, actor } = context;
    const registry = requireFamily();
    await body(context, API_SCHEMAS.authorizeAgent);
    try {
      const agent = registry.authorizeAgent(tenantId, context.params[0], { authorizer: actor });
      auditSafe("platform.agent.authorized", `${agent.id} ${agent.family}/${agent.role}`);
      return send(response, 200, { agent });
    } catch (error) {
      if (error instanceof FamilyError) auditSafe("platform.agent.refused", `${context.params[0]}: ${error.code}`);
      throw error;
    }
  }

  // -- memory --------------------------------------------------------------

  const ownerPrincipal = () => ({ userId: OWNER_USER_ID });

  function searchMemory(context) {
    const { url, tenantId, response } = context;
    const store = requireMemory();
    const query = url.searchParams.get("query") ?? "";
    if (query.length > 500) throw new ApiError(422, "query must be at most 500 characters.");
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const entries = store.retrieve(tenantId, ownerPrincipal(), { query: query || undefined, limit });
    return send(response, 200, { entries, capabilities: store.capabilities() });
  }

  async function writeMemory(context) {
    const { tenantId, response, actor } = context;
    const store = requireMemory();
    const input = await body(context, API_SCHEMAS.writeMemory);
    const scope = input.scope ?? "user";
    const entry = store.write({
      tenantId, owner: actor, scope, scopeRef: input.scopeRef ?? (scope === "user" ? OWNER_USER_ID : tenantId),
      kind: input.kind ?? "observation", content: input.content,
      provenance: { source: input.source ?? "owner.api", sourceRefs: input.sourceRefs ?? [], producedBy: actor },
      retention: input.retentionDays ? { policy: "days", days: input.retentionDays } : { policy: "indefinite" },
      // The owner always keeps read access to what the owner wrote.
      ...(scope === "family" && { access: { readers: [`family:${input.scopeRef ?? tenantId}`, `user:${OWNER_USER_ID}`] } }),
    });
    auditSafe("platform.memory.written", `${entry.id} (${entry.scope})`);
    return send(response, 201, { entry });
  }

  async function correctMemory(context) {
    const { tenantId, response, actor } = context;
    const store = requireMemory();
    const input = await body(context, API_SCHEMAS.correctMemory);
    const entry = store.correct(context.params[0], input.content, { tenantId, by: actor, reason: input.reason });
    auditSafe("platform.memory.corrected", `${context.params[0]} -> ${entry.id}`);
    return send(response, 201, { entry });
  }

  async function deleteMemory(context) {
    const { tenantId, response, actor, url } = context;
    const store = requireMemory();
    const reason = url.searchParams.get("reason") || "deleted by owner";
    if (reason.length > 500) throw new ApiError(422, "reason must be at most 500 characters.");
    const result = store.delete(context.params[0], { tenantId, by: actor, reason });
    auditSafe("platform.memory.deleted", `${context.params[0]} (${result.erasedIds.length} version(s) erased)`);
    return send(response, 200, result);
  }

  function exportMemory(context) {
    const { tenantId, response, identity } = context;
    // A bulk export is the one read a stolen device token should not get.
    if (identity?.role !== "admin") throw new ApiError(403, "Only the local owner can export memory.");
    const exported = requireMemory().export(tenantId, ownerPrincipal());
    response.setHeader("content-disposition", "attachment; filename=\"atlas-memory-export.json\"");
    return sendRaw(response, 200, exported);
  }

  // -- costs and workers ---------------------------------------------------

  function costs(context) {
    const { tenantId, response } = context;
    const zero = () => Object.fromEntries(BUDGET_DIMENSIONS.map((d) => [d, 0]));
    const add = (into, usage = {}) => { for (const d of BUDGET_DIMENSIONS) into[d] += Number(usage[d] ?? 0); return into; };
    const totals = zero();
    const byAgent = new Map();
    const byStatus = {};
    const rows = allTasks(tenantId).map((task) => {
      add(totals, task.usage);
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
      const key = task.agentId ?? "unassigned";
      if (!byAgent.has(key)) byAgent.set(key, { agentId: task.agentId ?? null, tasks: 0, usage: zero() });
      const agentRow = byAgent.get(key);
      agentRow.tasks += 1;
      add(agentRow.usage, task.usage);
      return { id: task.id, objective: task.objective, status: task.status, agentId: task.agentId, usage: task.usage, budget: task.budget };
    });
    const agents = [...byAgent.values()];
    if (family) {
      for (const row of agents) {
        const agent = row.agentId ? family.getAgent(tenantId, row.agentId) : null;
        if (agent) Object.assign(row, { name: agent.name ?? null, role: agent.role, family: agent.family, budget: agent.budget, consumed: agent.consumed, remaining: agent.remaining });
      }
    }
    return send(response, 200, { dimensions: BUDGET_DIMENSIONS, totals, byStatus, tasks: rows, agents });
  }

  function workers(context) {
    const { tenantId, response } = context;
    let browser;
    try { browser = browserProbe(); } catch (error) { browser = { available: false, reason: error instanceof Error ? error.message : "probe failed" }; }
    const terminalReport = terminal
      ? { available: true, rootDirectory: terminal.rootDirectory, capabilities: terminal.capabilities(), workspaces: terminal.listWorkspaces().filter((w) => w.tenantId === tenantId).length }
      : { available: false, reason: "The terminal controller is not running in this process." };
    const mcpReport = mcp
      ? {
        available: true,
        servers: [...mcp.servers.values()].filter((entry) => entry.tenantId === tenantId).map((entry) => ({
          ...mcp.serverInfo(entry.serverId, { tenantId }),
          connected: Boolean(entry.client),
          tools: entry.tools ? [...entry.tools.values()].length : null,
          flagged: entry.flagged.length,
          rejected: entry.rejected.length,
        })),
      }
      : { available: false, reason: "The MCP gateway is not running in this process.", servers: [] };
    const memoryReport = memory ? { available: true, ...memory.capabilities() } : { available: false };
    return send(response, 200, { browser, terminal: terminalReport, mcp: mcpReport, memory: memoryReport, familyRegistry: { available: Boolean(family) } });
  }

  // -- emergency stop ------------------------------------------------------

  /**
   * Halts everything in flight for the tenant: every task that is authorized,
   * queued, running, waiting or verifying is cancelled, its pending approvals
   * are rejected so nothing can resume it, running agents are set idle, and
   * the stop itself is written to the audit log.
   */
  async function emergencyStop(context) {
    const { tenantId, response, actor } = context;
    const input = await body(context, API_SCHEMAS.emergencyStop);
    const reason = `emergency stop${input.reason ? `: ${input.reason}` : ""}`;
    const result = store.transaction(() => {
      const cancelled = [];
      const rejectedApprovals = [];
      for (const task of allTasks(tenantId).filter((row) => IN_FLIGHT_STATES.includes(row.status))) {
        const outcome = cancelOne(tenantId, task.id, { reason, actor });
        if (outcome) {
          cancelled.push(task.id);
          rejectedApprovals.push(...outcome.rejectedApprovals);
        }
      }
      // Approvals for tasks that are not in flight are refused too: nothing approved during a stop.
      for (const approval of store.listApprovals(tenantId, { status: "pending" })) {
        rejectedApprovals.push(store.resolveApproval(tenantId, approval.id, { decision: "rejected", resolvedBy: actor, reason }).id);
      }
      return { cancelled, rejectedApprovals };
    });
    const idledAgents = [];
    if (family) {
      for (const agent of family.listAgents(tenantId, { state: "running" })) {
        try { family.completeAgentWork(tenantId, agent.id, { actor, reason }); idledAgents.push(agent.id); } catch { /* Report what stopped. */ }
      }
    }
    const cancelledAssignments = result.cancelled.flatMap((id) => cancelDelegation(tenantId, id, actor, reason));
    let hook = null;
    if (typeof onEmergencyStop === "function") {
      try { hook = (await onEmergencyStop({ tenantId, actor, reason, cancelled: result.cancelled })) ?? null; }
      catch (error) { hook = { error: error instanceof Error ? error.message : "stop hook failed" }; }
    }
    const stoppedAt = new Date().toISOString();
    auditSafe("platform.emergency_stop", `${actor} stopped ${result.cancelled.length} task(s), rejected ${result.rejectedApprovals.length} approval(s), idled ${idledAgents.length} agent(s): ${reason}`);
    return send(response, 200, { stoppedAt, reason, ...result, idledAgents, cancelledAssignments, hook });
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

const STORE_STATUS = {
  NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  CONCURRENT_MODIFICATION: 409,
  ALREADY_RESOLVED: 409,
  ALREADY_VERIFIED: 409,
  SCHEMA_VIOLATION: 422,
  INVALID_DECISION: 422,
};
const FAMILY_STATUS = {
  AGENT_NOT_FOUND: 404,
  UNKNOWN_SUBTASK: 404,
  ILLEGAL_AGENT_TRANSITION: 409,
  AGENT_NOT_ACTIVE: 409,
  TASK_CLOSED: 409,
  DUPLICATE_ASSIGNMENT: 409,
  PERMISSION_ESCALATION: 403,
  POLICY_DENIED: 403,
  DELEGATION_NOT_DOWNWARD: 403,
  SELF_DELEGATION: 403,
  RECURSIVE_DELEGATION: 403,
  NOT_ACCOUNTABLE_OWNER: 403,
  SAME_FAMILY: 422,
};
const MEMORY_STATUS = { NOT_FOUND: 404, ALREADY_SUPERSEDED: 409, ALREADY_DELETED: 409, DELETED: 409 };

function sendError(response, error) {
  if (error instanceof ApiError) return send(response, error.status, { message: error.message, ...(error.details ?? {}) });
  if (error?.code === "BODY_TOO_LARGE") return send(response, 413, { message: error.message });
  const code = typeof error?.code === "string" ? error.code : null;
  const message = error instanceof Error ? error.message : "Request failed.";
  if (error?.name === "FamilyError") return send(response, FAMILY_STATUS[code] ?? 422, { code, message });
  if (error?.name === "MemoryError") return send(response, MEMORY_STATUS[code] ?? 422, { code, message });
  if (error?.name === "PlatformStoreError" || error?.name === "ContractError") return send(response, STORE_STATUS[code] ?? 422, { code, message });
  return send(response, 500, { message: "The platform could not complete this request." });
}

async function readBody(request) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new Error("Request body is too large."); error.code = "BODY_TOO_LARGE"; throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) { const error = new Error("Request body is too large."); error.code = "BODY_TOO_LARGE"; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function summarizeAgent(agent) {
  if (!agent) return null;
  const { id, name, role, family, state, parentId, permissions, budget, depth } = agent;
  return { id, name: name ?? null, role, family, state, parentId, permissions, budget, depth };
}

function withoutBulkyContent(artifact) {
  const size = JSON.stringify(artifact.content ?? null).length;
  return size > 16 * 1024 ? { ...artifact, content: { omitted: true, bytes: size } } : artifact;
}

const SECRET_KEY = /(^|_)(password|passwd|secret|token|access_key|apikey|api_key|authorization|cookie|cookies|credential|credentials|private_key|client_secret|session_key)$/u;

/** Deep copy with secret-named fields replaced and secret-shaped strings redacted. */
export function scrub(value, depth = 0) {
  if (depth > 32) return "[TRUNCATED]";
  if (typeof value === "string") return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const snake = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
      out[key] = SECRET_KEY.test(snake) && child !== null && child !== undefined ? "[REDACTED]" : scrub(child, depth + 1);
    }
    return out;
  }
  return value;
}

function send(response, status, value) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(value));
  return true;
}

function sendRaw(response, status, textBody) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(textBody);
  return true;
}
