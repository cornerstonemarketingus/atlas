import {
  BUDGET_DIMENSIONS,
  SCHEMA_VERSION,
  assertSchema,
  defineTool,
  digest,
  executionResultSchema,
  newId,
  policyDecisionSchema,
  validateSchema,
} from "../../../../packages/atlas-contracts/src/index.mjs";
import { TaskBudget, TaskBudgetExceededError } from "./budget.mjs";
import { createRedactor, hostSecretValues, redactStructured } from "./terminal/redaction.mjs";

/**
 * The single door every platform tool call walks through.
 *
 * Order matters and is fixed: tenant-scoped task lookup, input validation
 * (refused before any budget is touched), idempotent replay, policy decision
 * (persisted before anything runs), approval check, budget reservation, then
 * execution under a timeout, and finally truthful charging and audit events.
 * Every step writes durable state, so a crash mid-call leaves a record of how
 * far the call got rather than a silent gap.
 *
 * `invoke` returns an outcome envelope rather than throwing for tool-level
 * failures: `{ status, toolCallId, replayed, approvalId?, decision?, result }`
 * where `result` is a strict ExecutionResult. It throws only for caller
 * errors (unknown task or tool, task not running, non-object input).
 */
export class ExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Tool errors cross the boundary as `{ code, message, retryable }` — never a stack trace. */
export function sanitizeToolError(error, { knownSecrets = [] } = {}) {
  const redact = createRedactor({ knownSecrets: [...knownSecrets, ...hostSecretValues()] });
  const rawMessage = typeof error?.message === "string" ? error.message : String(error ?? "Tool failed.");
  const safeMessage = redact(rawMessage).text;
  const message = safeMessage.split("\n")[0].replace(/\s+at\s+\S+\s*\(.*$/u, "").slice(0, 500) || "Tool failed.";
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) && redact(error.code).text === error.code ? error.code : "TOOL_ERROR";
  return { code, message, retryable: error?.retryable === true };
}

function sanitizeUsage(usage) {
  if (!isPlainObject(usage)) return {};
  return Object.fromEntries(
    Object.entries(usage).filter(([d, v]) => BUDGET_DIMENSIONS.includes(d) && d !== "toolCalls" && d !== "wallTimeMs" && Number.isInteger(v) && v >= 0),
  );
}

function jsonSafe(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

class TimeoutError extends Error {
  constructor(ms) {
    super(`Tool exceeded its ${ms} ms time limit.`);
    this.code = "TIMEOUT";
    this.retryable = true;
  }
}

export class AuthorizedToolExecutor {
  #store;
  #policy;
  #clock;
  #tools = new Map();
  #defaultTimeoutMs;
  #approvalTtlMs;
  #approvalContext;
  #redact;

  constructor({ store, policy, clock = () => new Date(), defaultTimeoutMs = DEFAULT_TIMEOUT_MS, approvalTtlMs = DEFAULT_APPROVAL_TTL_MS,
    approvalContext = ({ task }) => ({ repository: task?.repository ?? null, revision: task?.baseRevision ?? task?.revision ?? null, version: task?.contextVersion ?? null }), knownSecrets = [] }) {
    if (!store || !policy) throw new ExecutorError("MISCONFIGURED", "The executor needs a store and a policy engine.");
    this.#store = store;
    this.#policy = policy;
    this.#clock = clock;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    this.#approvalTtlMs = approvalTtlMs;
    // Only trusted runtime wiring supplies repository/revision context; model
    // arguments and invoke callers cannot substitute it.
    this.#approvalContext = approvalContext;
    this.#redact = createRedactor({ knownSecrets: [...knownSecrets, ...hostSecretValues()] });
  }

  register(definition, { timeoutMs = this.#defaultTimeoutMs } = {}) {
    const tool = defineTool(definition);
    if (this.#tools.has(tool.name)) throw new ExecutorError("DUPLICATE_TOOL", `Tool '${tool.name}' is already registered.`);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new ExecutorError("INVALID_TIMEOUT", "timeoutMs must be a positive integer.");
    this.#tools.set(tool.name, { tool, timeoutMs });
    return this;
  }

  has(name) { return this.#tools.has(name); }
  list() {
    return [...this.#tools.values()].map(({ tool, timeoutMs }) => ({
      name: tool.name, description: tool.description, risk: tool.risk, consequential: tool.consequential, inputSchema: tool.inputSchema, timeoutMs,
    }));
  }

  async invoke({ tenantId, userId, agentId = null, taskId, tool: toolName, input, grantedPermissions = [], approvalId = null }) {
    const store = this.#store;
    const task = store.getTask(tenantId, taskId);
    if (!task) throw new ExecutorError("NOT_FOUND", "No such task in this tenant.");
    if (task.status !== "running") throw new ExecutorError("TASK_NOT_RUNNING", `Tools run only for a running task; this one is '${task.status}'.`);
    const registered = this.#tools.get(toolName);
    if (!registered) throw new ExecutorError("UNKNOWN_TOOL", `There is no tool named '${toolName}'.`);
    if (!isPlainObject(input)) throw new ExecutorError("INVALID_INPUT", "Tool input must be an object.");
    // Refuse secrets before input is recorded, hashed, audited or executed.
    // Credentials must enter through declared vault references instead.
    const safeInput = this.#scrub(input);
    const plaintextCredential = JSON.stringify(safeInput) !== JSON.stringify(input);
    input = safeInput;
    const { tool, timeoutMs } = registered;
    const { correlationId } = task;
    const binding = this.#binding({ tenantId, taskId, task, userId, agentId });
    const key = digest({ version: 2, tenantId, taskId, tool: tool.name, input, binding });
    const actor = { tenantId, userId, agentId, taskId, correlationId };

    const prior = store.getIdempotency(tenantId, key);
    // Older receipts lack principal and trusted-context binding. Never forget
    // them on upgrade and silently repeat an external mutation.
    const legacyPrior = store.getIdempotency(tenantId, digest({ tenantId, taskId, tool: tool.name, input }));
    if (!plaintextCredential && prior?.status === "succeeded") {
      return { status: "succeeded", replayed: true, toolCallId: prior.toolCallId, result: this.#scrub(prior.result) };
    }
    if (!plaintextCredential && prior?.status === "in_flight") {
      return this.#outcome("in_flight", prior.toolCallId, {
        error: { code: "DUPLICATE_IN_FLIGHT", message: "The same action is already running.", retryable: true },
      });
    }

    // A verified approval may resume the very tool call that asked for it.
    let approvalContext = null;
    let approvalProblem = null;
    let resumeCallId = null;
    if (approvalId) {
      const approval = store.getApproval(tenantId, approvalId);
      if (!approval) approvalProblem = "approval does not exist in this tenant";
      else if (approval.taskId !== taskId) approvalProblem = "approval belongs to a different task";
      else if (approval.tool !== tool.name || approval.actionDigest !== key) approvalProblem = "approval was granted for a different action";
      else if (approval.requestedBy !== userId) approvalProblem = "approval belongs to a different principal";
      else if (approval.status !== "approved") approvalProblem = `approval is '${approval.status}', not approved`;
      else if (approval.consumedBy) approvalProblem = "approval has already been used";
      else {
        approvalContext = { id: approval.id, verified: true };
        const pending = approval.toolCallId ? store.getToolCall(tenantId, approval.toolCallId) : null;
        if (pending?.status === "awaiting_approval") resumeCallId = pending.id;
      }
    }

    const call = store.transaction(() => {
      const record = resumeCallId
        ? store.updateToolCall(tenantId, resumeCallId, { status: "requested" })
        : store.recordToolCall({ tenantId, taskId, userId, agentId, tool: tool.name, input, status: "requested", idempotencyKey: key, correlationId });
      this.#emit(actor, "tool_call.requested", { toolCallId: record.id, tool: tool.name, inputDigest: digest(input), resumed: Boolean(resumeCallId), approvalId });
      return record;
    });

    if (plaintextCredential) {
      const decision = this.#denial({ tenantId, userId, agentId, taskId, tool }, ["Plaintext credentials are forbidden in tool arguments."]);
      store.transaction(() => {
        store.recordPolicyDecision(decision, { toolCallId: call.id, correlationId });
        store.updateToolCall(tenantId, call.id, { policyDecisionId: decision.id });
        this.#emit(actor, "tool_call.decided", { toolCallId: call.id, tool: tool.name, decisionId: decision.id, effect: decision.effect, reasons: decision.reasons, policyVersion: decision.policyVersion });
      });
      return { ...this.#finish(actor, call.id, "denied", {
        error: { code: "PLAINTEXT_CREDENTIAL", message: "Tool arguments must reference credentials rather than include secret values.", retryable: false },
      }), decision };
    }

    if (legacyPrior) {
      const decision = this.#denial({ tenantId, userId, agentId, taskId, tool }, ["An earlier authorization format already recorded this action."]);
      store.transaction(() => {
        store.recordPolicyDecision(decision, { toolCallId: call.id, correlationId });
        store.updateToolCall(tenantId, call.id, { policyDecisionId: decision.id });
        this.#emit(actor, "tool_call.decided", { toolCallId: call.id, tool: tool.name, decisionId: decision.id, effect: decision.effect, reasons: decision.reasons, policyVersion: decision.policyVersion });
      });
      return { ...this.#finish(actor, call.id, "denied", {
        error: { code: "LEGACY_ACTION_RECEIPT", message: "This action has a receipt from an earlier authorization format. Review its outcome before starting a new action.", retryable: false },
      }), decision };
    }

    const inputErrors = validateSchema(tool.inputSchema, input, "input");
    if (inputErrors.length > 0) {
      const error = { code: "INVALID_INPUT", message: inputErrors.map((e) => `${e.path} ${e.message}`).join("; ").slice(0, 500), retryable: false };
      return this.#finish(actor, call.id, "failed", { error });
    }

    const decision = this.#scrub(approvalProblem
      ? this.#denial({ tenantId, userId, agentId, taskId, tool }, [approvalProblem])
      : this.#policy.evaluate({ tenantId, userId, agentId, taskId, tool, input, grantedPermissions, approval: approvalContext }));
    store.transaction(() => {
      store.recordPolicyDecision(decision, { toolCallId: call.id, correlationId });
      store.updateToolCall(tenantId, call.id, { policyDecisionId: decision.id });
      this.#emit(actor, "tool_call.decided", {
        toolCallId: call.id, tool: tool.name, decisionId: decision.id, effect: decision.effect, reasons: decision.reasons, policyVersion: decision.policyVersion,
      });
    });

    if (decision.effect === "deny") {
      const error = { code: "POLICY_DENIED", message: decision.reasons.join("; ").slice(0, 500), retryable: false };
      return { ...this.#finish(actor, call.id, "denied", { error }), decision };
    }

    if (decision.effect === "require_approval") {
      const approval = store.transaction(() => {
        store.updateToolCall(tenantId, call.id, { status: "awaiting_approval" });
        return store.createApproval({
          tenantId, taskId, toolCallId: call.id, tool: tool.name, actionDigest: key, requestedBy: userId,
          expiresAt: new Date(this.#clock().getTime() + this.#approvalTtlMs).toISOString(),
        });
      });
      return {
        ...this.#outcome("awaiting_approval", call.id, {
          error: { code: "APPROVAL_REQUIRED", message: decision.reasons.join("; ").slice(0, 500), retryable: true },
        }),
        approvalId: approval.id,
        decision,
      };
    }

    // allow
    if (!store.claimIdempotency({ tenantId, taskId, key, toolCallId: call.id })) {
      const error = { code: "DUPLICATE_IN_FLIGHT", message: "The same action is already running.", retryable: true };
      return { ...this.#finish(actor, call.id, "failed", { error }), decision };
    }

    const budget = new TaskBudget({ store, tenantId, taskId });
    try {
      budget.reserve({ toolCalls: 1 });
    } catch (error) {
      store.releaseIdempotency(tenantId, key);
      if (!(error instanceof TaskBudgetExceededError)) throw error;
      return { ...this.#finish(actor, call.id, "failed", { error: { code: "BUDGET_EXCEEDED", message: error.message, retryable: false } }), decision };
    }

    const currentTask = store.getTask(tenantId, taskId);
    const currentBinding = this.#binding({ tenantId, taskId, task: currentTask, userId, agentId });
    if (currentTask?.status !== "running" || digest(binding) !== digest(currentBinding) || (approvalContext && !store.consumeApproval(tenantId, approvalContext.id, call.id, { taskId, tool: tool.name, actionDigest: key, requestedBy: userId }))) {
      store.releaseIdempotency(tenantId, key);
      const error = { code: "POLICY_DENIED", message: "action context changed, or approval expired or has already been used", retryable: false };
      return { ...this.#finish(actor, call.id, "denied", { error }), decision };
    }

    const wallRemaining = budget.remaining("wallTimeMs");
    const limitMs = Math.max(1, Math.min(timeoutMs, wallRemaining));
    store.updateToolCall(tenantId, call.id, { status: "running" });

    const started = performance.now();
    let outcome;
    try {
      // Adapters may await vault access after the approval is consumed. They
      // recheck this trusted gate immediately before the external action,
      // without consuming a second approval or exposing request arguments.
      const assertAuthorized = () => {
        const current = store.getTask(tenantId, taskId);
        if (current?.status !== "running" || digest(binding) !== digest(this.#binding({ tenantId, taskId, task: current, userId, agentId }))) {
          throw new ExecutorError("POLICY_DENIED", "The task or trusted action context changed before execution.");
        }
        if (approvalContext) {
          const approval = store.getApproval(tenantId, approvalContext.id);
          if (approval?.status !== "approved" || approval.consumedBy !== call.id || approval.taskId !== taskId
            || approval.tool !== tool.name || approval.actionDigest !== key || approval.requestedBy !== userId) {
            throw new ExecutorError("POLICY_DENIED", "The action approval expired or no longer authorizes this call.");
          }
        }
      };
      const value = await runWithTimeout(tool, input, { correlationId, taskId, tenantId, userId, agentId, toolCallId: call.id, assertAuthorized }, limitMs);
      const wrapped = isPlainObject(value) && "output" in value ? value : { output: value };
      outcome = {
        ok: true,
        output: jsonSafe(wrapped.output),
        evidence: Array.isArray(wrapped.evidence) ? jsonSafe(wrapped.evidence.filter(isPlainObject)) : [],
        usage: sanitizeUsage(wrapped.usage),
      };
    } catch (error) {
      outcome = { ok: false, error: sanitizeToolError(error), usage: {} };
    }
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    const charged = { ...outcome.usage, wallTimeMs: durationMs };
    budget.charge(charged);
    const usage = { toolCalls: 1, ...charged };

    if (outcome.ok) {
      const finished = this.#finish(actor, call.id, "succeeded", { output: outcome.output, evidence: outcome.evidence, usage, durationMs });
      store.completeIdempotency(tenantId, key, finished.result);
      return { ...finished, decision };
    }
    store.releaseIdempotency(tenantId, key);
    return { ...this.#finish(actor, call.id, "failed", { error: outcome.error, usage, durationMs }), decision };
  }

  #denial({ tenantId, userId, agentId, taskId, tool }, reasons) {
    return assertSchema(policyDecisionSchema, {
      schemaVersion: SCHEMA_VERSION,
      id: newId("policyDecision"),
      effect: "deny",
      reasons,
      tool: tool.name,
      risk: tool.risk,
      tenantId,
      userId,
      agentId,
      taskId,
      policyVersion: this.#policy.version,
      decidedAt: this.#clock().toISOString(),
    }, "policy decision");
  }

  #scrub(value) {
    return redactStructured(value, this.#redact);
  }

  #binding({ tenantId, taskId, task, userId, agentId }) {
    const trusted = this.#approvalContext({ tenantId, taskId, task });
    if (!isPlainObject(trusted) || ![Object.prototype, null].includes(Object.getPrototypeOf(trusted))) throw new ExecutorError("MISCONFIGURED", "Trusted approval context must be a synchronous plain object.");
    // Task lifecycle versions advance while waiting for approval. Bind the
    // trusted work context instead, so waiting/resuming does not revoke an
    // otherwise unchanged action.
    const binding = { userId, agentId, contextVersion: trusted.version ?? null, repository: trusted.repository ?? null, revision: trusted.revision ?? null };
    if (binding.contextVersion !== null && typeof binding.contextVersion !== "string" && !Number.isSafeInteger(binding.contextVersion)) throw new ExecutorError("MISCONFIGURED", "Trusted context version must be a string or integer.");
    for (const value of [binding.repository, binding.revision]) {
      if (value !== null && (typeof value !== "string" || value.length > 4096)) throw new ExecutorError("MISCONFIGURED", "Trusted repository and revision must be bounded strings.");
    }
    return binding;
  }

  #outcome(status, toolCallId, { output = undefined, error = null, evidence = undefined, usage = undefined }) {
    output = this.#scrub(output);
    error = this.#scrub(error);
    evidence = this.#scrub(evidence);
    const result = assertSchema(executionResultSchema, {
      schemaVersion: SCHEMA_VERSION,
      ok: status === "succeeded",
      toolCallId,
      ...(output !== undefined && { output }),
      error,
      ...(evidence !== undefined && { evidence }),
      ...(usage !== undefined && { usage }),
    }, "execution result");
    return { status, replayed: false, toolCallId, result };
  }

  /** Persists the terminal tool-call state and its completion event together. */
  #finish(actor, toolCallId, status, { output = undefined, error = null, evidence = undefined, usage = undefined, durationMs = undefined }) {
    output = this.#scrub(output);
    error = this.#scrub(error);
    evidence = this.#scrub(evidence);
    const envelope = this.#outcome(status, toolCallId, { output, error, evidence, usage });
    this.#store.transaction(() => {
      this.#store.updateToolCall(actor.tenantId, toolCallId, {
        status, error, ...(output !== undefined && { output }), ...(durationMs !== undefined && { durationMs }),
      });
      this.#emit(actor, "tool_call.completed", { toolCallId, status, ok: envelope.result.ok, error, durationMs: durationMs ?? null });
    });
    return envelope;
  }

  #emit({ tenantId, userId, agentId, taskId, correlationId }, type, payload) {
    this.#store.appendEvent({ type, tenantId, correlationId, taskId, userId, agentId, payload: this.#scrub(payload) });
  }
}

async function runWithTimeout(tool, input, context, limitMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(limitMs);
      controller.abort(error);
      reject(error);
    }, limitMs);
  });
  try {
    // The race stops waiting even for a tool that ignores its abort signal.
    const assertAuthorized = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      context.assertAuthorized?.();
    };
    return await Promise.race([Promise.resolve().then(() => {
      assertAuthorized();
      return tool.execute(input, { ...context, signal: controller.signal, assertAuthorized });
    }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Judges an artifact with a deterministic `check(artifact) -> { ok, evidence[] }`.
 *
 * An artifact is marked verified only when its stored content still matches
 * its digest, the check returns `ok: true`, and it produced at least one
 * structured evidence object. A passing check with no evidence, or evidence
 * that is bare prose, is a rejection: "looks good" is not verification.
 */
export async function verifyArtifact(store, { tenantId, artifactId, check, knownSecrets = [] }) {
  if (typeof check !== "function") throw new ExecutorError("INVALID_CHECK", "verifyArtifact needs a check function.");
  const artifact = store.getArtifact(tenantId, artifactId);
  if (!artifact) throw new ExecutorError("NOT_FOUND", "No such artifact in this tenant.");

  if (digest(artifact.content) !== artifact.contentDigest) {
    return store.markArtifactVerified(tenantId, artifactId, {
      verified: false, evidence: [{ check: "content_digest", ok: false, expected: artifact.contentDigest }],
    });
  }
  let verified = false;
  let evidence;
  try {
    const outcome = await check(artifact);
    const items = Array.isArray(outcome?.evidence) ? outcome.evidence : [];
    if (items.some((item) => !isPlainObject(item))) {
      evidence = [{ check: "evidence_shape", ok: false, message: "evidence must be structured objects, not prose" }];
    } else if (outcome?.ok === true && items.length === 0) {
      evidence = [{ check: "evidence_required", ok: false, message: "check passed without producing evidence" }];
    } else {
      verified = outcome?.ok === true;
      evidence = [{ check: "content_digest", ok: true, contentDigest: artifact.contentDigest }, ...jsonSafe(items)];
    }
  } catch (error) {
    evidence = [{ check: "check_error", ok: false, error: sanitizeToolError(error, { knownSecrets }) }];
  }
  const safeEvidence = redactStructured(evidence, createRedactor({ knownSecrets: [...knownSecrets, ...hostSecretValues()] }));
  return store.markArtifactVerified(tenantId, artifactId, { verified, evidence: safeEvidence });
}
