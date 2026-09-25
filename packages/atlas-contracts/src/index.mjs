import { createHash, randomUUID } from "node:crypto";

/**
 * Versioned contracts shared by the Atlas control plane (task intake, policy,
 * budgets, approvals) and the execution plane (browser, terminal, desktop and
 * coding workers).
 *
 * Every record crossing a plane boundary is a plain JSON object stamped with
 * `schemaVersion` and validated here, so a worker that speaks an older or
 * malformed contract is refused at the boundary instead of half-understood.
 * This package deliberately has no dependencies: the local control plane must
 * stay installable without an npm registry, and a contract that needs a
 * library to be read is a contract two planes can disagree about.
 */
export const SCHEMA_VERSION = "atlas.v1";

export class ContractError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const ID_PREFIXES = Object.freeze({
  task: "tsk",
  step: "stp",
  toolCall: "tcl",
  agent: "agt",
  artifact: "art",
  approval: "apr",
  event: "evt",
  correlation: "cor",
  workerSession: "wks",
  policyDecision: "pol",
  message: "msg",
});

const ID_PATTERN = /^(tsk|stp|tcl|agt|art|apr|evt|cor|wks|pol|msg)_[0-9a-f]{32}$/;

export function newId(kind) {
  const prefix = ID_PREFIXES[kind];
  if (!prefix) throw new ContractError("UNKNOWN_ID_KIND", `Unknown id kind '${kind}'.`);
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function isId(value, kind = undefined) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return false;
  return kind === undefined || value.startsWith(`${ID_PREFIXES[kind]}_`);
}

/** A correlation id ties every task, step, tool call and event of one objective together. */
export function newCorrelationId() {
  return newId("correlation");
}

/**
 * Accepts a correlation id handed in from outside (an HTTP header, a workflow
 * input) only when it is exactly the shape Atlas issues; anything else is
 * replaced so a caller cannot smuggle text into logs through it.
 */
export function acceptCorrelationId(candidate) {
  return isId(candidate, "correlation") ? candidate : newCorrelationId();
}

// ---------------------------------------------------------------------------
// Canonical JSON and digests
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted, so equal values always hash equally. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ContractError("NON_FINITE_NUMBER", "Canonical JSON cannot encode a non-finite number.");
    }
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/**
 * Idempotency key for an external action: the same actor asking for the same
 * tool with the same input inside the same task is the same action, so a
 * retry after a lost response cannot perform it twice.
 */
export function idempotencyKey({ tenantId, taskId, tool, input }) {
  return digest({ tenantId, taskId, tool, input });
}

// ---------------------------------------------------------------------------
// Minimal JSON-schema subset validator
// ---------------------------------------------------------------------------

/**
 * Validates the subset of JSON Schema Atlas tool contracts use: type, enum,
 * const, required, properties, additionalProperties:false, items, minLength,
 * maxLength, pattern, minimum, maximum, minItems, maxItems. Returns a list of
 * `{ path, message }`; an empty list means valid. Unknown keywords are ignored
 * so the validator is safe to point at richer schemas, but tool schemas should
 * stay inside the subset so what is declared is what is enforced.
 */
export function validateSchema(schema, value, path = "$") {
  const errors = [];
  const fail = (message, at = path) => errors.push({ path: at, message });
  if (!schema || typeof schema !== "object") return errors;

  if ("const" in schema && canonicalJson(schema.const) !== canonicalJson(value)) {
    fail(`must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => canonicalJson(option) === canonicalJson(value))) {
    fail(`must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      fail(`must be of type ${types.join(" | ")}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) fail("does not match the required pattern");
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(`must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, `${path}[${index}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) fail("is required", `${path}.${key}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) errors.push(...validateSchema(properties[key], child, `${path}.${key}`));
      else if (schema.additionalProperties === false) fail("is not an allowed property", `${path}.${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateSchema(schema.additionalProperties, child, `${path}.${key}`));
      }
    }
  }
  return errors;
}

function matchesType(type, value) {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: return false;
  }
}

export function assertSchema(schema, value, label = "value") {
  const errors = validateSchema(schema, value);
  if (errors.length) {
    throw new ContractError("SCHEMA_VIOLATION", `${label} is invalid: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}.`, errors);
  }
  return value;
}

// ---------------------------------------------------------------------------
// State machines
// ---------------------------------------------------------------------------

/**
 * Task lifecycle (blueprint §3). A transition not listed here is refused, so
 * a task can never jump from `queued` to `completed` without having run and
 * been verified.
 */
export const TASK_TRANSITIONS = Object.freeze({
  proposed: ["authorized", "cancelled", "failed"],
  authorized: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["waiting_for_dependency", "waiting_for_approval", "verifying", "failed", "cancelled"],
  waiting_for_dependency: ["running", "failed", "cancelled"],
  waiting_for_approval: ["running", "failed", "cancelled"],
  verifying: ["completed", "failed", "running", "cancelled"],
  completed: ["archived"],
  failed: ["archived", "queued"],
  cancelled: ["archived"],
  archived: [],
});

export const TASK_STATES = Object.freeze(Object.keys(TASK_TRANSITIONS));
export const TASK_TERMINAL_STATES = Object.freeze(["completed", "failed", "cancelled", "archived"]);

export function canTransition(from, to, transitions = TASK_TRANSITIONS) {
  return Boolean(transitions[from]?.includes(to));
}

export function assertTransition(from, to, transitions = TASK_TRANSITIONS) {
  if (!canTransition(from, to, transitions)) {
    throw new ContractError("ILLEGAL_TRANSITION", `A task cannot move from '${from}' to '${to}'.`, { from, to });
  }
}

export const TOOL_CALL_STATES = Object.freeze(["requested", "denied", "awaiting_approval", "running", "succeeded", "failed"]);
export const APPROVAL_STATES = Object.freeze(["pending", "approved", "rejected", "expired"]);
export const POLICY_EFFECTS = Object.freeze(["allow", "deny", "require_approval"]);
export const RISK_LEVELS = Object.freeze(["read", "low", "moderate", "high", "critical"]);
export const ARTIFACT_VERIFICATION = Object.freeze(["unverified", "verified", "rejected"]);

/** Typed inter-agent messages (blueprint §3). */
export const MESSAGE_TYPES = Object.freeze([
  "TASK_ASSIGNMENT", "ACCEPTED", "PROGRESS", "RESULT", "HELP_REQUEST", "CROSS_FAMILY_REQUEST",
  "REVIEW_REQUEST", "REVIEW_RESULT", "ESCALATION", "CANCEL",
]);

/** Normalized event kinds written to the audit/event stream. */
export const EVENT_TYPES = Object.freeze([
  "task.created", "task.transitioned", "step.created", "step.transitioned",
  "tool_call.requested", "tool_call.decided", "tool_call.completed",
  "approval.requested", "approval.resolved", "budget.charged", "budget.exceeded",
  "artifact.submitted", "artifact.verified", "worker_session.opened", "worker_session.closed",
  "agent.message",
]);

// ---------------------------------------------------------------------------
// Schemas for the core records
// ---------------------------------------------------------------------------

const idString = { type: "string", minLength: 1, maxLength: 128 };
const timestamp = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$" };

export const BUDGET_DIMENSIONS = Object.freeze(["toolCalls", "wallTimeMs", "inputTokens", "outputTokens", "costMicroUsd"]);

export const budgetSchema = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(BUDGET_DIMENSIONS.map((d) => [d, { type: "integer", minimum: 0 }])),
};

export const actorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId", "userId"],
  properties: { tenantId: idString, userId: idString, agentId: idString },
};

export const taskSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "tenantId", "userId", "correlationId", "objective", "status", "successCriteria", "budget", "createdAt", "updatedAt"],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    id: idString,
    tenantId: idString,
    userId: idString,
    agentId: { type: ["string", "null"], maxLength: 128 },
    parentTaskId: { type: ["string", "null"], maxLength: 128 },
    correlationId: idString,
    traceId: { type: ["string", "null"], maxLength: 128 },
    objective: { type: "string", minLength: 1, maxLength: 8000 },
    status: { enum: TASK_STATES },
    successCriteria: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 1000 } },
    budget: budgetSchema,
    usage: budgetSchema,
    result: {},
    error: { type: ["object", "null"] },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
};

export const agentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "tenantId", "role", "family", "permissions", "persistent"],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    id: idString,
    tenantId: idString,
    name: { type: "string", maxLength: 200 },
    role: { type: "string", minLength: 1, maxLength: 64 },
    family: { type: "string", minLength: 1, maxLength: 64 },
    permissions: { type: "array", maxItems: 256, items: { type: "string", minLength: 1, maxLength: 128 } },
    persistent: { type: "boolean" },
    modelPreference: { type: ["string", "null"], maxLength: 128 },
    budget: budgetSchema,
  },
};

export const toolCallSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "taskId", "tenantId", "userId", "correlationId", "tool", "input", "status", "idempotencyKey", "createdAt"],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    id: idString,
    taskId: idString,
    stepId: { type: ["string", "null"], maxLength: 128 },
    tenantId: idString,
    userId: idString,
    agentId: { type: ["string", "null"], maxLength: 128 },
    correlationId: idString,
    tool: { type: "string", pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$", maxLength: 128 },
    input: { type: "object" },
    status: { enum: TOOL_CALL_STATES },
    idempotencyKey: idString,
    policyDecisionId: { type: ["string", "null"], maxLength: 128 },
    output: {},
    error: { type: ["object", "null"] },
    durationMs: { type: ["integer", "null"], minimum: 0 },
    createdAt: timestamp,
    completedAt: { type: ["string", "null"] },
  },
};

export const policyDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "effect", "reasons", "tool", "tenantId", "userId", "decidedAt", "policyVersion"],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    id: idString,
    effect: { enum: POLICY_EFFECTS },
    reasons: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 500 } },
    tool: { type: "string", maxLength: 128 },
    risk: { enum: RISK_LEVELS },
    tenantId: idString,
    userId: idString,
    agentId: { type: ["string", "null"], maxLength: 128 },
    taskId: { type: ["string", "null"], maxLength: 128 },
    policyVersion: { type: "string", minLength: 1, maxLength: 64 },
    decidedAt: timestamp,
  },
};

export const executionResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "ok", "toolCallId"],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    ok: { type: "boolean" },
    toolCallId: idString,
    output: {},
    error: {
      type: ["object", "null"],
      properties: { code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" } },
    },
    evidence: { type: "array", items: { type: "object" } },
    usage: budgetSchema,
  },
};

export const artifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "taskId", "tenantId", "kind", "contentDigest", "verification", "createdAt"],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    id: idString,
    taskId: idString,
    tenantId: idString,
    toolCallId: { type: ["string", "null"], maxLength: 128 },
    kind: { type: "string", minLength: 1, maxLength: 64 },
    mediaType: { type: "string", maxLength: 128 },
    content: {},
    storageRef: { type: ["string", "null"], maxLength: 1024 },
    contentDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    verification: { enum: ARTIFACT_VERIFICATION },
    verificationEvidence: { type: "array", items: { type: "object" } },
    createdAt: timestamp,
  },
};

export const agentMessageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "type", "source", "destination", "taskId", "correlationId", "payload", "createdAt"],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    id: idString,
    type: { enum: MESSAGE_TYPES },
    source: idString,
    destination: idString,
    taskId: idString,
    correlationId: idString,
    payload: { type: "object" },
    createdAt: timestamp,
  },
};

export const eventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "type", "tenantId", "correlationId", "payload", "createdAt"],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    id: idString,
    type: { enum: EVENT_TYPES },
    tenantId: idString,
    userId: { type: ["string", "null"], maxLength: 128 },
    agentId: { type: ["string", "null"], maxLength: 128 },
    taskId: { type: ["string", "null"], maxLength: 128 },
    correlationId: idString,
    traceId: { type: ["string", "null"], maxLength: 128 },
    payload: { type: "object" },
    createdAt: timestamp,
  },
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * A tool the execution plane can run. `risk` and `consequential` feed the
 * policy engine; `inputSchema` is enforced before the policy is even asked,
 * so a malformed call is refused without consuming budget.
 *
 * @typedef {object} ToolDefinition
 * @property {string} name        dotted name, e.g. "browser.navigate"
 * @property {string} description
 * @property {"read"|"low"|"moderate"|"high"|"critical"} risk
 * @property {boolean} consequential  true when it changes the outside world (submit, send, purchase, merge, deploy)
 * @property {object} inputSchema
 * @property {(input: object, context: object) => Promise<{output: any, evidence?: object[], usage?: object}>} execute
 */
export function defineTool(definition) {
  const { name, description, risk, consequential = false, inputSchema, execute } = definition ?? {};
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(name)) {
    throw new ContractError("INVALID_TOOL", "A tool name must be dotted lower_snake_case, e.g. 'browser.navigate'.");
  }
  if (typeof description !== "string" || !description) throw new ContractError("INVALID_TOOL", `Tool '${name}' needs a description.`);
  if (!RISK_LEVELS.includes(risk)) throw new ContractError("INVALID_TOOL", `Tool '${name}' has unknown risk '${risk}'.`);
  if (!inputSchema || inputSchema.type !== "object") throw new ContractError("INVALID_TOOL", `Tool '${name}' needs an object inputSchema.`);
  if (typeof execute !== "function") throw new ContractError("INVALID_TOOL", `Tool '${name}' needs an execute function.`);
  return Object.freeze({ name, description, risk, consequential: Boolean(consequential), inputSchema, execute });
}

export function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}
