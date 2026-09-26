import { BUDGET_DIMENSIONS, canTransition } from "../../../../../packages/atlas-contracts/src/index.mjs";

import { TaskBudget } from "../budget.mjs";
import { ExecutorError, sanitizeToolError } from "../executor.mjs";
import { redactSecrets } from "../memory/redaction.mjs";
import { validateToolCall } from "../models/tool-call.mjs";
import { OrchestratorError, requireTenant } from "./store.mjs";

/**
 * Model-driven single-agent loop (blueprint §3, §12).
 *
 *   observe -> plan (model call) -> validate tool call -> executor.invoke
 *   (policy, approval, budget) -> observe -> ... -> task.finish ->
 *   verify against the task's success criteria -> complete | continue | escalate
 *
 * Rules the loop never bends:
 *  - The model proposes; it never decides. Every proposed call is validated
 *    against the declared tool schemas, and every executed call goes through
 *    the AuthorizedToolExecutor (policy, approvals, budgets, idempotency).
 *  - Success is never inferred from prose. The only way to `completed` is the
 *    model calling `task.finish` AND every success criterion having a
 *    declared verifier that returns `{ ok: true, evidence: [ {..}, ... ] }`
 *    with at least one structured evidence object. A verification report is
 *    stored as a verified artifact so the completion is auditable.
 *  - Everything is bounded: steps, invalid outputs per model, tool retries,
 *    policy denials, verification failures. When a bound is hit the task is
 *    failed with an `ESCALATED` error and an ESCALATION record requiring a
 *    human is opened — the loop does not keep guessing.
 *
 * Failure classes: policy_denied, budget_exceeded, tool_error_retryable,
 * tool_error_fatal, model_invalid_output, model_unavailable,
 * verification_failed, step_limit.
 *
 * `modelClient.complete({ model, messages, tools })` must resolve to
 * `{ toolCalls?: [call, ...], content?: string, usage?: { inputTokens, outputTokens, costMicroUsd } }`
 * where each call is any shape `validateToolCall` accepts.
 */
export const FINISH_TOOL = Object.freeze({
  name: "task.finish",
  description: "Declare the objective done and request verification. Completion happens only if every success criterion's verifier passes with evidence.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      artifactIds: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
});

export const ERROR_CLASSES = Object.freeze([
  "policy_denied", "budget_exceeded", "tool_error_retryable", "tool_error_fatal",
  "model_invalid_output", "model_unavailable", "verification_failed", "step_limit",
]);

const DEFAULT_LIMITS = Object.freeze({
  maxSteps: 12,
  maxInvalidPerModel: 1,
  maxToolRetries: 2,
  maxPolicyDenials: 2,
  maxFatalToolErrors: 2,
  maxVerificationFailures: 2,
  leaseTtlMs: 5 * 60_000,
});

/** Maps an executor outcome to a failure class (or null for success / approval pause). */
export function classifyOutcome(outcome) {
  if (outcome.status === "succeeded" || outcome.status === "awaiting_approval") return null;
  const code = outcome.result?.error?.code;
  if (outcome.status === "denied" || code === "POLICY_DENIED") return "policy_denied";
  if (code === "BUDGET_EXCEEDED") return "budget_exceeded";
  if (code === "INVALID_INPUT") return "model_invalid_output";
  if (outcome.status === "in_flight" || outcome.result?.error?.retryable === true) return "tool_error_retryable";
  return "tool_error_fatal";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactText(text) {
  return redactSecrets(text).text;
}

function observation(payload) {
  return redactText(JSON.stringify(payload)).slice(0, 16_000);
}

function sanitizeModelUsage(usage) {
  if (!isPlainObject(usage)) return {};
  return Object.fromEntries(Object.entries(usage)
    .filter(([key, value]) => ["inputTokens", "outputTokens", "costMicroUsd"].includes(key) && Number.isInteger(value) && value >= 0));
}

/** Normalizes declared verifiers into `[{ name, criteria: [...], check }]`. */
function normalizeVerifiers(verifiers) {
  const list = Array.isArray(verifiers)
    ? verifiers
    : Object.entries(verifiers ?? {}).map(([criterion, check]) => ({ name: criterion, criteria: [criterion], check }));
  return list.map((verifier, index) => {
    if (!verifier || typeof verifier.check !== "function") throw new OrchestratorError("INVALID_VERIFIER", `Verifier ${index} needs a check function.`);
    const criteria = verifier.criteria ?? (verifier.criterion !== undefined ? [verifier.criterion] : []);
    if (!Array.isArray(criteria) || criteria.length === 0) throw new OrchestratorError("INVALID_VERIFIER", `Verifier ${verifier.name ?? index} must name the success criteria it checks.`);
    return { name: verifier.name ?? `verifier_${index}`, criteria, check: verifier.check };
  });
}

export class AgentLoop {
  #store;
  #executor;
  #orch;
  #modelClient;
  #router;
  #limits;
  #owner;

  /**
   * @param deps { store, executor, orchestratorStore, modelClient, router?, limits?, owner? }
   *   `router` is a CapabilityRouter; when given, `run({ routing })` asks it
   *   for `{ model, fallbacks }` and falls back along that list.
   */
  constructor({ store, executor, orchestratorStore, modelClient, router = null, limits = {}, owner = "agent-loop" }) {
    if (!store || !executor || !orchestratorStore || typeof modelClient?.complete !== "function") {
      throw new OrchestratorError("MISCONFIGURED", "AgentLoop needs store, executor, orchestratorStore and a modelClient with complete().");
    }
    if (executor.has(FINISH_TOOL.name)) throw new OrchestratorError("MISCONFIGURED", `'${FINISH_TOOL.name}' is reserved for the loop.`);
    this.#store = store;
    this.#executor = executor;
    this.#orch = orchestratorStore;
    this.#modelClient = modelClient;
    this.#router = router;
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#owner = owner;
  }

  #models({ models, routing }) {
    if (Array.isArray(models) && models.length > 0) return [...models];
    if (this.#router && routing) {
      const decision = this.#router.route(routing);
      return [decision.model, ...decision.fallbacks];
    }
    throw new OrchestratorError("NO_MODEL", "run() needs `models` or a router with `routing`.");
  }

  #toolSchemas(allowedTools) {
    const listed = this.#executor.list().filter((tool) => !allowedTools || allowedTools.includes(tool.name));
    return [...listed.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })), FINISH_TOOL];
  }

  /**
   * Drives one task until it completes, pauses for approval, is paused or
   * cancelled by an operator, or escalates.
   *
   * @returns {{ status: 'completed'|'waiting_for_approval'|'paused'|'cancelled'|'escalated', taskId, steps, ... }}
   */
  async run({ tenantId, taskId, userId, agentId = null, grantedPermissions = [], allowedTools = undefined, verifiers = [], models = undefined, routing = undefined }) {
    requireTenant(tenantId);
    const task = this.#store.getTask(tenantId, taskId);
    if (!task) throw new OrchestratorError("NOT_FOUND", "No such task in this tenant.");
    const declared = normalizeVerifiers(verifiers);
    const modelList = this.#models({ models, routing });
    const tools = this.#toolSchemas(allowedTools);
    const ctx = { tenantId, taskId, userId: userId ?? task.userId, agentId: agentId ?? task.agentId ?? null, grantedPermissions, declared, modelList, tools };

    if (!this.#orch.acquireLease(tenantId, taskId, this.#owner, this.#limits.leaseTtlMs)) {
      throw new OrchestratorError("LEASE_HELD", "Another worker is driving this task.");
    }
    try {
      return await this.#drive(ctx);
    } finally {
      this.#orch.releaseLease(tenantId, taskId, this.#owner);
    }
  }

  #initialState(task) {
    return {
      step: 0,
      modelIndex: 0,
      invalidForModel: 0,
      policyDenials: 0,
      fatalToolErrors: 0,
      verificationFailures: 0,
      pendingApproval: null,
      messages: [
        {
          role: "system",
          content: "You are an Atlas agent. Act only through the provided tools. When the objective is met, call task.finish; completion is decided by verifiers, not by your statement.",
        },
        {
          role: "user",
          content: redactText(`Objective: ${task.objective}\nSuccess criteria:\n${task.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`),
        },
      ],
      evidence: [],
    };
  }

  #save(ctx, state) {
    this.#orch.saveCheckpoint(ctx.tenantId, ctx.taskId, state);
  }

  async #drive(ctx) {
    const { tenantId, taskId } = ctx;
    let task = this.#store.getTask(tenantId, taskId);
    let state = this.#orch.loadCheckpoint(tenantId, taskId) ?? this.#initialState(task);

    const control = this.#orch.getControl(tenantId, taskId);
    if (control.cancelRequested || task.status === "cancelled") return { status: "cancelled", taskId, steps: state.step };
    if (control.paused) return { status: "paused", taskId, steps: state.step };

    // Enter running from wherever the task legitimately waits.
    if (task.status === "queued") task = this.#transition(ctx, "running", "agent loop picked up task");
    else if (task.status === "waiting_for_approval") {
      const resumed = await this.#resumeApproval(ctx, state);
      if (resumed) return resumed;
      task = this.#store.getTask(tenantId, taskId);
    } else if (task.status === "verifying") task = this.#transition(ctx, "running", "resuming after interrupted verification");
    else if (task.status !== "running") {
      throw new OrchestratorError("TASK_NOT_RUNNABLE", `The agent loop cannot drive a task in '${task.status}'.`);
    }

    while (state.step < this.#limits.maxSteps) {
      const flags = this.#orch.getControl(tenantId, taskId);
      if (flags.cancelRequested) { this.#save(ctx, state); return { status: "cancelled", taskId, steps: state.step }; }
      if (flags.paused) { this.#save(ctx, state); return { status: "paused", taskId, steps: state.step }; }
      if (this.#store.getTask(tenantId, taskId).status !== "running") {
        this.#save(ctx, state);
        return { status: this.#store.getTask(tenantId, taskId).status, taskId, steps: state.step };
      }
      this.#orch.acquireLease(tenantId, taskId, this.#owner, this.#limits.leaseTtlMs);

      const spent = this.#spentDimension(ctx);
      if (spent) return this.#escalate(ctx, state, "budget_exceeded", `Task budget '${spent}' is exhausted.`);

      state.step += 1;
      const model = ctx.modelList[state.modelIndex];

      // plan
      let response;
      try {
        response = await this.#modelClient.complete({ model, messages: structuredClone(state.messages), tools: ctx.tools });
      } catch (error) {
        const next = this.#nextModel(ctx, state, "model_unavailable", sanitizeToolError(error).message);
        if (!next) return this.#escalate(ctx, state, "model_unavailable", `Every model failed: ${sanitizeToolError(error).message}`);
        this.#save(ctx, state);
        continue;
      }
      const usage = sanitizeModelUsage(response?.usage);
      if (Object.keys(usage).length > 0) {
        const { exceeded } = new TaskBudget({ store: this.#store, tenantId, taskId }).charge(usage);
        if (exceeded.length > 0) {
          return this.#escalate(ctx, state, "budget_exceeded", `Model usage exceeded the budget on ${exceeded.map((e) => e.dimension).join(", ")}.`);
        }
      }

      const rawCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : response?.toolCall ? [response.toolCall] : [];
      if (rawCalls.length === 0) {
        // Prose is not an action and is never taken as a claim of success.
        const next = this.#invalidOutput(ctx, state, model, [{ path: "$", message: "The response contained no tool call. Act through a tool, or call task.finish." }], response?.content);
        if (!next) return this.#escalate(ctx, state, "model_invalid_output", "No model produced a valid tool call.");
        this.#save(ctx, state);
        continue;
      }
      const validation = validateToolCall(rawCalls[0], ctx.tools);
      if (!validation.ok) {
        const next = this.#invalidOutput(ctx, state, model, validation.errors, JSON.stringify(rawCalls[0]).slice(0, 2000));
        if (!next) return this.#escalate(ctx, state, "model_invalid_output", "No model produced a valid tool call.", { errors: validation.errors });
        this.#save(ctx, state);
        continue;
      }
      state.invalidForModel = 0;
      const call = validation.call;
      state.messages.push({ role: "assistant", content: null, toolCall: { name: call.name, arguments: JSON.parse(redactText(JSON.stringify(call.arguments))) } });

      if (call.name === FINISH_TOOL.name) {
        const verdict = await this.#verify(ctx, state, call.arguments);
        if (verdict.done) return verdict.result;
        continue;
      }

      const acted = await this.#act(ctx, state, call.name, call.arguments, null);
      if (acted) return acted;
      this.#save(ctx, state);
    }
    return this.#escalate(ctx, state, "step_limit", `The loop reached its ${this.#limits.maxSteps}-step limit without verified completion.`);
  }

  #spentDimension({ tenantId, taskId }) {
    const { remaining } = new TaskBudget({ store: this.#store, tenantId, taskId }).snapshot();
    const task = this.#store.getTask(tenantId, taskId);
    return BUDGET_DIMENSIONS.find((d) => remaining[d] === 0 && task.budget[d] > 0) ?? null;
  }

  /** Records an invalid model output; returns false when every model has used its retries. */
  #invalidOutput(ctx, state, model, errors, raw) {
    state.messages.push({ role: "assistant", content: raw ? redactText(String(raw)).slice(0, 2000) : null });
    state.messages.push({ role: "user", content: observation({ error: "model_invalid_output", model, errors }) });
    state.invalidForModel += 1;
    if (state.invalidForModel > this.#limits.maxInvalidPerModel) return this.#nextModel(ctx, state, "model_invalid_output", "invalid output");
    return true;
  }

  /** Switches to the next fallback model; returns false when none is left. */
  #nextModel(ctx, state, errorClass, message) {
    state.modelIndex += 1;
    state.invalidForModel = 0;
    state.fallbacks = [...(state.fallbacks ?? []), { errorClass, message: String(message).slice(0, 300), toModel: ctx.modelList[state.modelIndex] ?? null }];
    return state.modelIndex < ctx.modelList.length;
  }

  /**
   * Executes one validated tool call with bounded retries for retryable
   * errors. Returns a terminal loop result (pause/escalation) or null to
   * continue.
   */
  async #act(ctx, state, tool, input, approvalId) {
    const { tenantId, taskId, userId, agentId, grantedPermissions } = ctx;
    let outcome;
    for (let attempt = 0; ; attempt += 1) {
      try {
        outcome = await this.#executor.invoke({ tenantId, userId, agentId, taskId, tool, input, grantedPermissions, approvalId: attempt === 0 ? approvalId : null });
      } catch (error) {
        if (error instanceof ExecutorError && ["UNKNOWN_TOOL", "INVALID_INPUT"].includes(error.code)) {
          state.messages.push({ role: "tool", name: tool, content: observation({ ok: false, errorClass: "model_invalid_output", error: { code: error.code, message: error.message } }) });
          return null;
        }
        throw error;
      }
      const errorClass = classifyOutcome(outcome);
      if (errorClass !== "tool_error_retryable" || attempt >= this.#limits.maxToolRetries) break;
    }

    if (outcome.status === "awaiting_approval") {
      state.pendingApproval = { approvalId: outcome.approvalId, toolCallId: outcome.toolCallId, tool, input };
      this.#transition(ctx, "waiting_for_approval", `approval ${outcome.approvalId} required for ${tool}`);
      this.#save(ctx, state);
      return { status: "waiting_for_approval", taskId, approvalId: outcome.approvalId, toolCallId: outcome.toolCallId, steps: state.step };
    }

    const errorClass = classifyOutcome(outcome);
    const result = outcome.result;
    state.messages.push({
      role: "tool", name: tool, toolCallId: outcome.toolCallId,
      content: observation(result.ok ? { ok: true, output: result.output, evidence: result.evidence ?? [] } : { ok: false, errorClass, error: result.error }),
    });
    if (result.ok) {
      state.evidence.push({ toolCallId: outcome.toolCallId, tool, output: result.output ?? null, evidence: result.evidence ?? [] });
      return null;
    }
    switch (errorClass) {
      case "budget_exceeded":
        return this.#escalate(ctx, state, "budget_exceeded", result.error.message, { toolCallId: outcome.toolCallId });
      case "policy_denied":
        state.policyDenials += 1;
        if (state.policyDenials > this.#limits.maxPolicyDenials) return this.#escalate(ctx, state, "policy_denied", "The agent kept proposing actions policy denies.", { lastError: result.error });
        return null;
      case "model_invalid_output":
        return null;
      default:
        state.fatalToolErrors += 1;
        if (state.fatalToolErrors > this.#limits.maxFatalToolErrors) return this.#escalate(ctx, state, errorClass, `Tool failures exceeded the limit: ${result.error.message}`, { lastError: result.error });
        return null;
    }
  }

  /** Continues a task parked on an approval. Returns a loop result to stop, or null to keep driving. */
  async #resumeApproval(ctx, state) {
    const pending = state.pendingApproval;
    if (!pending) {
      this.#transition(ctx, "running", "resuming without a recorded pending approval");
      return null;
    }
    const approval = this.#store.getApproval(ctx.tenantId, pending.approvalId);
    if (!approval || approval.status === "pending") {
      return { status: "waiting_for_approval", taskId: ctx.taskId, approvalId: pending.approvalId, steps: state.step };
    }
    this.#transition(ctx, "running", `approval ${approval.id} ${approval.status}`);
    state.pendingApproval = null;
    if (approval.status === "approved") {
      const stopped = await this.#act(ctx, state, pending.tool, pending.input, approval.id);
      this.#save(ctx, state);
      return stopped;
    }
    state.policyDenials += 1;
    state.messages.push({ role: "tool", name: pending.tool, content: observation({ ok: false, errorClass: "policy_denied", error: { code: "APPROVAL_" + approval.status.toUpperCase(), message: `A human ${approval.status} this action.` } }) });
    if (state.policyDenials > this.#limits.maxPolicyDenials) return this.#escalate(ctx, state, "policy_denied", "Approvals were repeatedly refused.");
    this.#save(ctx, state);
    return null;
  }

  /**
   * running -> verifying -> completed only with evidence from a verifier for
   * every success criterion. Otherwise verifying -> running with the failure
   * fed back to the model, bounded.
   */
  async #verify(ctx, state, finish) {
    const { tenantId, taskId } = ctx;
    const task = this.#transition(ctx, "verifying", "model requested completion");
    const results = [];
    const uncovered = task.successCriteria.filter((criterion) => !ctx.declared.some((v) => v.criteria.includes(criterion) || v.criteria.includes("*")));
    for (const verifier of ctx.declared) {
      let ok = false;
      let evidence = [];
      let problem = null;
      try {
        const outcome = await verifier.check({
          task, finish, evidence: structuredClone(state.evidence), store: this.#store, tenantId, taskId,
          artifacts: this.#store.listArtifacts(tenantId, { taskId }),
        });
        const items = Array.isArray(outcome?.evidence) ? outcome.evidence : [];
        if (items.some((item) => !isPlainObject(item))) problem = "evidence must be structured objects, not prose";
        else if (outcome?.ok === true && items.length === 0) problem = "verifier passed without producing evidence";
        else { ok = outcome?.ok === true; evidence = JSON.parse(JSON.stringify(items)); if (!ok) problem = outcome?.reason ?? "verifier returned not ok"; }
      } catch (error) {
        problem = `verifier threw: ${sanitizeToolError(error).message}`;
      }
      results.push({ verifier: verifier.name, criteria: verifier.criteria, ok, evidence, problem });
    }
    const passed = uncovered.length === 0 && results.length > 0 && results.every((r) => r.ok);

    if (passed) {
      const report = { summary: redactText(finish.summary), results, criteria: task.successCriteria };
      const allEvidence = results.flatMap((r) => r.evidence.map((item) => ({ verifier: r.verifier, ...item })));
      const artifact = this.#store.submitArtifact({ tenantId, taskId, kind: "verification_report", content: report });
      this.#store.markArtifactVerified(tenantId, artifact.id, { verified: true, evidence: allEvidence });
      this.#store.transitionTask(tenantId, taskId, "completed", {
        actor: this.#owner, expectedStatus: "verifying", reason: "all success criteria verified with evidence",
        result: { summary: report.summary, verificationArtifactId: artifact.id, verifiers: results.map((r) => ({ verifier: r.verifier, ok: r.ok, evidenceCount: r.evidence.length })) },
      });
      this.#orch.clearCheckpoint(tenantId, taskId);
      return { done: true, result: { status: "completed", taskId, steps: state.step, verificationArtifactId: artifact.id, results } };
    }

    state.verificationFailures += 1;
    const failure = {
      error: "verification_failed",
      uncoveredCriteria: uncovered,
      verifiers: results.map((r) => ({ verifier: r.verifier, ok: r.ok, problem: r.problem })),
    };
    if (ctx.declared.length === 0) failure.message = "No verifiers are declared for this task; it cannot be completed automatically.";
    this.#transition(ctx, "running", "verification failed");
    state.messages.push({ role: "tool", name: FINISH_TOOL.name, content: observation(failure) });
    if (ctx.declared.length === 0 || uncovered.length > 0 || state.verificationFailures > this.#limits.maxVerificationFailures) {
      return { done: true, result: this.#escalate(ctx, state, "verification_failed", failure.message ?? "Completion could not be verified with evidence.", failure) };
    }
    this.#save(ctx, state);
    return { done: false };
  }

  #transition(ctx, to, reason) {
    return this.#store.transitionTask(ctx.tenantId, ctx.taskId, to, { actor: this.#owner, reason });
  }

  /** Fails the task with an ESCALATED error and opens a human-required escalation. */
  #escalate(ctx, state, errorClass, message, details = {}) {
    const { tenantId, taskId } = ctx;
    const task = this.#store.getTask(tenantId, taskId);
    const escalation = this.#orch.createEscalation({
      tenantId, taskId, correlationId: task.correlationId, source: "agent_loop",
      reason: `${errorClass}: ${String(message).slice(0, 400)}`,
      details: { errorClass, step: state.step, modelIndex: state.modelIndex, fallbacks: state.fallbacks ?? [], ...details },
    });
    this.#store.appendEvent({
      type: "agent.message", tenantId, correlationId: task.correlationId, taskId, userId: task.userId, agentId: task.agentId ?? null,
      payload: { messageType: "ESCALATION", escalationId: escalation.id, errorClass, reason: escalation.reason },
    });
    const error = { code: "ESCALATED", errorClass, message: String(message).slice(0, 500), escalationId: escalation.id };
    const current = this.#store.getTask(tenantId, taskId).status;
    if (canTransition(current, "failed")) {
      this.#store.transitionTask(tenantId, taskId, "failed", { actor: this.#owner, reason: `escalated: ${errorClass}`, error });
    }
    this.#save(ctx, state);
    return { status: "escalated", taskId, errorClass, escalationId: escalation.id, steps: state.step };
  }
}
