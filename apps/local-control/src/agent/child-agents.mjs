import { randomUUID } from "node:crypto";

import { BUDGET_DIMENSIONS, normalizeBudget } from "./budget.mjs";

export const CHILD_AGENT_STATES = Object.freeze([
  "queued",
  "running",
  "stopped",
  "completed",
  "failed",
  "cancelled",
]);

export const CHILD_AGENT_TERMINAL_STATES = Object.freeze(["completed", "failed", "cancelled"]);

const MESSAGE_KINDS = new Set(["instruction", "context", "question", "answer", "status"]);
const ACTIVE_STATES = new Set(["queued", "running", "stopped"]);
const TERMINAL_STATES = new Set(CHILD_AGENT_TERMINAL_STATES);
const MAX_MESSAGE_BYTES = 128 * 1024;

function clone(value) {
  return structuredClone(value);
}

function uniqueStrings(value, field) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new ChildAgentError("INVALID_CONTRACT", `'${field}' must be an array of non-empty strings.`);
  }
  return [...new Set(value)].sort();
}

function emptyBudget() {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0]));
}

function normalizeAllocation(value, field = "budget") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChildAgentError("INVALID_CONTRACT", `'${field}' must specify every budget dimension.`);
  }
  const unknown = Object.keys(value).filter((key) => !BUDGET_DIMENSIONS.includes(key));
  const missing = BUDGET_DIMENSIONS.filter((key) => !(key in value));
  if (unknown.length || missing.length) {
    throw new ChildAgentError(
      "INVALID_CONTRACT",
      `'${field}' must contain exactly: ${BUDGET_DIMENSIONS.join(", ")}.`,
    );
  }
  const normalized = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    const amount = value[dimension];
    if (!Number.isFinite(amount) || amount < 0) {
      throw new ChildAgentError("INVALID_CONTRACT", `'${field}.${dimension}' must be a non-negative number.`);
    }
    normalized[dimension] = Math.floor(amount);
  }
  return normalized;
}

function addBudget(left, right) {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, left[dimension] + right[dimension]]));
}

function subtractBudget(left, right) {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, left[dimension] - right[dimension]]));
}

function availableBudget(agent) {
  return subtractBudget(subtractBudget(agent.capabilities.budget, agent.budgetConsumed), agent.budgetReserved);
}

function assertSubset(candidate, parent, field) {
  const parentSet = new Set(parent);
  const extra = candidate.filter((entry) => !parentSet.has(entry));
  if (extra.length) {
    throw new ChildAgentError("CAPABILITY_ESCALATION", `'${field}' cannot add: ${extra.join(", ")}.`);
  }
}

function normalizePolicy(policy = {}) {
  return {
    allowedActions: uniqueStrings(policy.allowedActions ?? [], "policy.allowedActions"),
    requiredApprovals: uniqueStrings(policy.requiredApprovals ?? [], "policy.requiredApprovals"),
    deniedActions: uniqueStrings(policy.deniedActions ?? [], "policy.deniedActions"),
  };
}

function deriveCapabilities(parent, request = {}) {
  const tools = uniqueStrings(request.tools ?? parent.capabilities.tools, "tools");
  assertSubset(tools, parent.capabilities.tools, "tools");

  const requestedPolicy = normalizePolicy(request.policy ?? parent.capabilities.policy);
  assertSubset(requestedPolicy.allowedActions, parent.capabilities.policy.allowedActions, "policy.allowedActions");
  assertSubset(parent.capabilities.policy.requiredApprovals, requestedPolicy.requiredApprovals, "policy.requiredApprovals");
  assertSubset(parent.capabilities.policy.deniedActions, requestedPolicy.deniedActions, "policy.deniedActions");

  // An explicit allocation prevents accidental fan-out from cloning the same
  // parent allowance into every child. Callers may deliberately allocate zero.
  const budget = normalizeAllocation(request.budget, "budget");
  const available = availableBudget(parent);
  for (const dimension of BUDGET_DIMENSIONS) {
    if (budget[dimension] > available[dimension]) {
      throw new ChildAgentError(
        "BUDGET_UNAVAILABLE",
        `Child budget '${dimension}' requests ${budget[dimension]}, but only ${available[dimension]} is unallocated.`,
      );
    }
  }
  return { tools, policy: requestedPolicy, budget };
}

function normalizeRootCapabilities(capabilities = {}) {
  return {
    tools: uniqueStrings(capabilities.tools ?? [], "tools"),
    policy: normalizePolicy(capabilities.policy),
    budget: normalizeBudget(capabilities.budget),
  };
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new ChildAgentError("INVALID_MESSAGE", "A message must be an object.");
  }
  if (!MESSAGE_KINDS.has(message.kind)) {
    throw new ChildAgentError("INVALID_MESSAGE", `Unknown message kind '${message.kind}'.`);
  }
  if (typeof message.text !== "string" || message.text.trim().length === 0) {
    throw new ChildAgentError("INVALID_MESSAGE", "Message text must be non-empty.");
  }
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
  } catch {
    throw new ChildAgentError("INVALID_MESSAGE", "A message must be JSON-serializable.");
  }
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new ChildAgentError("INVALID_MESSAGE", `A message cannot exceed ${MAX_MESSAGE_BYTES} bytes.`);
  }
  return { kind: message.kind, text: message.text, metadata: clone(message.metadata ?? {}) };
}

function normalizeResult(result = {}, status) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ChildAgentError("INVALID_RESULT", "A child result must be an object.");
  }
  if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
    throw new ChildAgentError("INVALID_RESULT", "A child result requires a non-empty summary.");
  }
  const usage = normalizeAllocation(result.usage ?? emptyBudget(), "result.usage");
  const handoff = result.handoff ?? {};
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    throw new ChildAgentError("INVALID_RESULT", "A result handoff must be an object.");
  }
  const normalized = {
    status,
    summary: result.summary,
    outputs: clone(result.outputs ?? []),
    evidence: clone(result.evidence ?? []),
    usage,
    handoff: {
      nextActions: clone(handoff.nextActions ?? []),
      blockers: clone(handoff.blockers ?? []),
      context: clone(handoff.context ?? {}),
    },
  };
  try {
    JSON.stringify(normalized);
  } catch {
    throw new ChildAgentError("INVALID_RESULT", "A child result must be JSON-serializable.");
  }
  return normalized;
}

export class ChildAgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChildAgentError";
    this.code = code;
  }
}

/**
 * In-memory lifecycle and authority registry for a tree of collaborating agents.
 * Persistence/execution are intentionally injected concerns: this object defines
 * the contract the scheduler and durable store must honor.
 */
export class ChildAgentRegistry {
  #agents = new Map();
  #messages = new Map();
  #idFactory;
  #now;
  #maxDepth;
  #maxFanout;

  constructor({ maxDepth = 3, maxFanout = 6, idFactory = randomUUID, now = () => new Date().toISOString() } = {}) {
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new ChildAgentError("INVALID_LIMIT", "maxDepth must be a non-negative integer.");
    if (!Number.isInteger(maxFanout) || maxFanout < 1) throw new ChildAgentError("INVALID_LIMIT", "maxFanout must be a positive integer.");
    this.#maxDepth = maxDepth;
    this.#maxFanout = maxFanout;
    this.#idFactory = idFactory;
    this.#now = now;
  }

  createRoot({ name = "coordinator", capabilities = {}, metadata = {} } = {}) {
    if (this.#agents.size !== 0) throw new ChildAgentError("ROOT_EXISTS", "This registry already has a root agent.");
    const id = this.#idFactory();
    const createdAt = this.#now();
    const agent = {
      id,
      name,
      parentId: null,
      rootId: id,
      depth: 0,
      path: [id],
      status: "running",
      capabilities: normalizeRootCapabilities(capabilities),
      budgetConsumed: emptyBudget(),
      budgetReserved: emptyBudget(),
      childIds: [],
      result: null,
      metadata: clone(metadata),
      createdAt,
      updatedAt: createdAt,
    };
    this.#agents.set(id, agent);
    this.#messages.set(id, []);
    return this.status(id);
  }

  spawn(parentId, { name, task, capabilities = {}, metadata = {} } = {}) {
    const parent = this.#agent(parentId);
    if (!ACTIVE_STATES.has(parent.status) || parent.status === "stopped") {
      throw new ChildAgentError("PARENT_NOT_RUNNING", "Children may be spawned only by a queued or running parent.");
    }
    if (parent.depth >= this.#maxDepth) throw new ChildAgentError("MAX_DEPTH", `Maximum child-agent depth ${this.#maxDepth} reached.`);
    if (parent.childIds.length >= this.#maxFanout) throw new ChildAgentError("MAX_FANOUT", `Maximum child-agent fanout ${this.#maxFanout} reached.`);
    if (typeof name !== "string" || name.trim().length === 0) throw new ChildAgentError("INVALID_CONTRACT", "A child requires a name.");
    if (typeof task !== "string" || task.trim().length === 0) throw new ChildAgentError("INVALID_CONTRACT", "A child requires a task.");

    const inherited = deriveCapabilities(parent, capabilities);
    const id = this.#idFactory();
    if (this.#agents.has(id)) throw new ChildAgentError("DUPLICATE_ID", `Agent id '${id}' already exists.`);
    const createdAt = this.#now();
    const agent = {
      id,
      name,
      task,
      parentId: parent.id,
      rootId: parent.rootId,
      depth: parent.depth + 1,
      path: [...parent.path, id],
      status: "queued",
      capabilities: inherited,
      budgetConsumed: emptyBudget(),
      budgetReserved: emptyBudget(),
      childIds: [],
      result: null,
      metadata: clone(metadata),
      createdAt,
      updatedAt: createdAt,
    };
    parent.childIds.push(id);
    parent.budgetReserved = addBudget(parent.budgetReserved, inherited.budget);
    parent.updatedAt = createdAt;
    this.#agents.set(id, agent);
    this.#messages.set(id, []);
    this.send(parent.id, id, { kind: "instruction", text: task, metadata: { initial: true } });
    return this.status(id);
  }

  start(id) {
    const agent = this.#agent(id);
    this.#transition(agent, ["queued"], "running", "NOT_QUEUED");
    return this.status(id);
  }

  send(fromId, toId, message) {
    const from = this.#agent(fromId);
    const to = this.#agent(toId);
    if (TERMINAL_STATES.has(from.status) || TERMINAL_STATES.has(to.status)) {
      throw new ChildAgentError("TERMINAL_AGENT", "Terminal agents cannot send or receive messages.");
    }
    const related = from.parentId === to.id || to.parentId === from.id || from.parentId === to.parentId;
    if (!related) throw new ChildAgentError("MESSAGE_SCOPE", "Messages are limited to parents, children, and siblings.");
    const normalized = normalizeMessage(message);
    const envelope = Object.freeze({
      id: this.#idFactory(),
      fromId,
      toId,
      ...normalized,
      createdAt: this.#now(),
    });
    this.#messages.get(toId).push(envelope);
    return clone(envelope);
  }

  messages(id, { after = 0 } = {}) {
    this.#agent(id);
    if (!Number.isInteger(after) || after < 0) throw new ChildAgentError("INVALID_CURSOR", "Message cursor must be a non-negative integer.");
    return clone(this.#messages.get(id).slice(after));
  }

  status(id) {
    const agent = this.#agent(id);
    return clone({ ...agent, budgetAvailable: availableBudget(agent) });
  }

  tree(rootId) {
    const root = this.#agent(rootId);
    if (root.parentId !== null) throw new ChildAgentError("NOT_ROOT", "tree() requires a root agent id.");
    return [...this.#agents.values()].filter((agent) => agent.rootId === root.id).map((agent) => this.status(agent.id));
  }

  stop(id, reason = "stopped by coordinator") {
    const agent = this.#agent(id);
    if (TERMINAL_STATES.has(agent.status)) throw new ChildAgentError("TERMINAL_AGENT", "A terminal agent cannot be stopped.");
    this.#walkActive(agent, (entry) => {
      entry.status = "stopped";
      entry.stopReason = reason;
      entry.updatedAt = this.#now();
    });
    return this.status(id);
  }

  resume(id) {
    const agent = this.#agent(id);
    if (TERMINAL_STATES.has(agent.status)) throw new ChildAgentError("TERMINAL_AGENT", "A terminal agent cannot be resumed.");
    if (agent.status !== "stopped") throw new ChildAgentError("NOT_STOPPED", "Only a stopped agent can be resumed.");
    if (agent.parentId && this.#agent(agent.parentId).status === "stopped") {
      throw new ChildAgentError("PARENT_STOPPED", "Resume the stopped parent before resuming its child.");
    }
    this.#walk(agent, (entry) => {
      if (entry.status === "stopped") {
        entry.status = "running";
        delete entry.stopReason;
        entry.updatedAt = this.#now();
      }
    });
    return this.status(id);
  }

  complete(id, result) {
    return this.#finish(id, "completed", result);
  }

  fail(id, result) {
    return this.#finish(id, "failed", result);
  }

  cancel(id, reason = "cancelled by coordinator") {
    const agent = this.#agent(id);
    if (TERMINAL_STATES.has(agent.status)) return this.status(id);
    for (const childId of [...agent.childIds]) this.cancel(childId, `ancestor cancelled: ${reason}`);
    return this.#finish(id, "cancelled", { summary: reason, usage: emptyBudget(), handoff: {} });
  }

  #finish(id, status, result) {
    const agent = this.#agent(id);
    if (TERMINAL_STATES.has(agent.status)) {
      if (agent.status === status) return this.status(id);
      throw new ChildAgentError("TERMINAL_AGENT", `Agent is already ${agent.status}.`);
    }
    const liveChild = agent.childIds.map((childId) => this.#agent(childId)).find((child) => !TERMINAL_STATES.has(child.status));
    if (liveChild) throw new ChildAgentError("CHILDREN_ACTIVE", `Child '${liveChild.id}' must reach a terminal state first.`);

    const normalized = normalizeResult(result, status);
    const total = addBudget(agent.budgetConsumed, normalized.usage);
    for (const dimension of BUDGET_DIMENSIONS) {
      if (total[dimension] > agent.capabilities.budget[dimension]) {
        throw new ChildAgentError("BUDGET_EXCEEDED", `Result usage exceeds the child's '${dimension}' allocation.`);
      }
    }
    agent.budgetConsumed = total;
    agent.status = status;
    agent.result = { ...normalized, usage: clone(total) };
    agent.updatedAt = this.#now();

    if (agent.parentId) {
      const parent = this.#agent(agent.parentId);
      parent.budgetReserved = subtractBudget(parent.budgetReserved, agent.capabilities.budget);
      parent.budgetConsumed = addBudget(parent.budgetConsumed, total);
      parent.updatedAt = this.#now();
    }
    return this.status(id);
  }

  #transition(agent, from, to, code) {
    if (!from.includes(agent.status)) throw new ChildAgentError(code, `Cannot transition '${agent.status}' to '${to}'.`);
    agent.status = to;
    agent.updatedAt = this.#now();
  }

  #walk(agent, visit) {
    visit(agent);
    for (const childId of agent.childIds) this.#walk(this.#agent(childId), visit);
  }

  #walkActive(agent, visit) {
    if (!TERMINAL_STATES.has(agent.status)) visit(agent);
    for (const childId of agent.childIds) this.#walkActive(this.#agent(childId), visit);
  }

  #agent(id) {
    const agent = this.#agents.get(id);
    if (!agent) throw new ChildAgentError("UNKNOWN_AGENT", `Unknown agent '${id}'.`);
    return agent;
  }
}
