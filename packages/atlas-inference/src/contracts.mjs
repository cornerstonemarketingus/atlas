/**
 * The shapes every Atlas model call is described in, whatever provider,
 * model or machine serves it (docs/PROGRAM.md Phase 1.1).
 *
 * Plain data with small validators, no classes: a request may be queued in
 * a Durable Object, handed to another target, or resumed by another worker,
 * so everything here must survive JSON.
 */

/** How urgently a request needs inference. A person waiting beats a background job. */
export const LatencyClass = Object.freeze({
  INTERACTIVE: "INTERACTIVE",
  TASK_CRITICAL: "TASK_CRITICAL",
  BACKGROUND: "BACKGROUND",
  BATCH: "BATCH",
});

const LATENCY_RANK = Object.freeze({ INTERACTIVE: 3, TASK_CRITICAL: 2, BACKGROUND: 1, BATCH: 0 });

/** Lifecycle of one inference request. Waiting is a state, never a failure. */
export const RequestState = Object.freeze({
  QUEUED: "QUEUED",
  WAITING_FOR_CAPACITY: "WAITING_FOR_CAPACITY",
  WAITING_FOR_TARGET: "WAITING_FOR_TARGET",
  RUNNING: "RUNNING",
  STREAMING: "STREAMING",
  RETRYING: "RETRYING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

const TERMINAL_STATES = new Set([RequestState.COMPLETED, RequestState.FAILED, RequestState.CANCELLED]);

/** Structured events every inference layer emits (metadata only, never content). */
export const InferenceEvent = Object.freeze({
  REQUESTED: "inference.requested",
  QUEUED: "inference.queued",
  STARTED: "inference.started",
  COMPLETED: "inference.completed",
  RATE_LIMITED: "inference.rate_limited",
  RETRY: "inference.retry",
  TARGET_CHANGED: "inference.target_changed",
  LOCAL_SELECTED: "inference.local_selected",
  EMPTY_RESPONSE: "inference.empty_response",
  FINALIZING: "inference.finalizing",
  PROVIDER_DEGRADED: "inference.provider_degraded",
  PROVIDER_RECOVERED: "inference.provider_recovered",
});

/**
 * @typedef {object} InferenceTarget One model on one endpoint that can serve requests.
 * @property {string} id Stable id, e.g. "groq/openai/gpt-oss-120b".
 * @property {string} provider "groq", "openai-compatible", "atlas-native", …
 * @property {string} origin Endpoint origin only (no path, query or credentials).
 * @property {string} model
 * @property {string} quotaScope Where the provider's limits are counted (e.g. one Groq organization), shared by every model under it.
 * @property {{ tools: boolean, json: boolean, streaming: boolean, reasoning: boolean }} capabilities
 * @property {number} contextWindowTokens
 * @property {number} maxOutputTokens
 * @property {boolean} local Runs on a machine the user controls.
 * @property {boolean} paid Using it can cost money; needs explicit policy.
 */

/**
 * @typedef {object} InferenceRequest
 * @property {string} id Idempotency key: the same id is never run twice.
 * @property {string} taskId
 * @property {string} [agentId]
 * @property {string} role "lead", "planner", "verifier", "agent", "child", "coder", "synthesis", …
 * @property {keyof typeof LatencyClass} latencyClass
 * @property {number} priority Higher first within a latency class.
 * @property {number} estimatedInputTokens
 * @property {number} maxOutputTokens
 * @property {{ tools?: boolean, json?: boolean, reasoning?: boolean }} requiredCapabilities
 * @property {string} [prefixFingerprint] Hash of the byte-stable prompt prefix, for cache-aware placement.
 * @property {keyof typeof RequestState} state
 */

/**
 * @typedef {object} InferenceUsage Token counts as the provider reported them (null when not reported).
 * @property {number|null} promptTokens
 * @property {number|null} completionTokens
 * @property {number|null} totalTokens
 * @property {number|null} reasoningTokens
 * @property {number|null} cachedTokens Prompt tokens served from the provider's cache.
 */

/**
 * @typedef {object} InferenceCheckpoint Compact state any eligible target can continue a task from.
 * @property {1} version
 * @property {string} taskId
 * @property {string} objective
 * @property {string[]} plan
 * @property {{ label: string, ok: boolean }[]} completedSteps
 * @property {string[]} relevantToolResults Bounded, newest kept when trimmed.
 * @property {string[]} changedFiles
 * @property {{ passed?: number, failed?: number, summary?: string } | null} validation
 * @property {string[]} failures
 * @property {string[]} unresolvedItems
 */

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * Validates and normalises a request. Throws TypeError naming the first
 * problem, so a malformed request fails where it was built, not in a queue.
 * @returns {InferenceRequest}
 */
export function createInferenceRequest(input) {
  const request = { ...input };
  if (typeof request.id !== "string" || !IDENTIFIER.test(request.id)) throw new TypeError("InferenceRequest.id must be an idempotency key of 1-128 safe characters.");
  if (typeof request.taskId !== "string" || !IDENTIFIER.test(request.taskId)) throw new TypeError("InferenceRequest.taskId is required.");
  if (typeof request.role !== "string" || !request.role) throw new TypeError("InferenceRequest.role is required.");
  request.latencyClass ??= LatencyClass.TASK_CRITICAL;
  if (!(request.latencyClass in LATENCY_RANK)) throw new TypeError(`Unknown latencyClass '${request.latencyClass}'.`);
  request.priority ??= 0;
  for (const field of ["priority", "estimatedInputTokens", "maxOutputTokens"]) {
    request[field] ??= 0;
    if (!Number.isFinite(request[field]) || request[field] < 0) throw new TypeError(`InferenceRequest.${field} must be a non-negative number.`);
  }
  request.requiredCapabilities = { ...(request.requiredCapabilities ?? {}) };
  request.state ??= RequestState.QUEUED;
  if (!(request.state in RequestState)) throw new TypeError(`Unknown request state '${request.state}'.`);
  return request;
}

/** Ordering for a queue: latency class, then priority, then first come. Negative means `a` goes first. */
export function compareRequests(a, b) {
  return (LATENCY_RANK[b.latencyClass] - LATENCY_RANK[a.latencyClass])
    || (b.priority - a.priority)
    || ((a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0));
}

export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

/** Usage from an OpenAI-compatible body or stream chunk (`usage`, or Groq's `x_groq.usage`). */
export function usageFrom(payload) {
  const usage = payload?.usage ?? payload?.x_groq?.usage;
  const count = (value) => (Number.isFinite(value) ? value : null);
  return {
    promptTokens: count(usage?.prompt_tokens),
    completionTokens: count(usage?.completion_tokens),
    totalTokens: count(usage?.total_tokens),
    reasoningTokens: count(usage?.completion_tokens_details?.reasoning_tokens),
    cachedTokens: count(usage?.prompt_tokens_details?.cached_tokens),
  };
}

const CHECKPOINT_LIMITS = Object.freeze({ objective: 4_000, item: 2_000, toolResults: 16_000, list: 50 });

function clip(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}… (shortened)` : text;
}

/**
 * Builds a bounded checkpoint. Tool results keep the newest when the total
 * would exceed the budget: the latest evidence is what the next step needs.
 * @returns {InferenceCheckpoint}
 */
export function createCheckpoint({ taskId, objective = "", plan = [], completedSteps = [], relevantToolResults = [], changedFiles = [], validation = null, failures = [], unresolvedItems = [] }) {
  if (typeof taskId !== "string" || !IDENTIFIER.test(taskId)) throw new TypeError("A checkpoint needs its taskId.");
  const list = (items) => items.slice(-CHECKPOINT_LIMITS.list).map((item) => clip(item, CHECKPOINT_LIMITS.item));
  const results = [];
  let room = CHECKPOINT_LIMITS.toolResults;
  for (const result of [...relevantToolResults].reverse()) {
    if (room <= 0) break;
    const clipped = clip(result, Math.min(CHECKPOINT_LIMITS.item * 2, room));
    results.unshift(clipped);
    room -= clipped.length;
  }
  return {
    version: 1, taskId, objective: clip(objective, CHECKPOINT_LIMITS.objective),
    plan: list(plan),
    completedSteps: completedSteps.slice(-CHECKPOINT_LIMITS.list).map((step) => ({ label: clip(step.label, 200), ok: Boolean(step.ok) })),
    relevantToolResults: results, changedFiles: list(changedFiles),
    validation: validation && typeof validation === "object" ? { ...validation } : null,
    failures: list(failures), unresolvedItems: list(unresolvedItems),
  };
}

/**
 * Whether `target` can ever serve `request`, before any queueing. A request
 * that cannot fit a target's context window, output limit or whole
 * per-minute allowance is not waited on there: it is routed elsewhere.
 * Per-minute limits come from ProviderCapacityState when known (null
 * otherwise). Groq enforces them per organization, and some organizations
 * also have separate input and output token limits; both are checked.
 *
 * Whether a provider counts the requested max_tokens against the per-minute
 * limit when it admits a request is not documented where Atlas could verify
 * it (2026-09-27), so the default is the conservative rule from the program
 * (input + max output), and a target that is known to count only input sets
 * `outputCountsTowardLimit: false`.
 *
 * @param {InferenceTarget} target
 * @param {InferenceRequest} request
 * @param {{ limitTokens?: number | null, limitInputTokens?: number | null, limitOutputTokens?: number | null, outputCountsTowardLimit?: boolean }} [capacity]
 * @returns {{ eligible: true } | { eligible: false, reason: string }}
 */
export function eligibility(target, request, { limitTokens = null, limitInputTokens = null, limitOutputTokens = null, outputCountsTowardLimit = true } = {}) {
  const needs = request.requiredCapabilities ?? {};
  for (const capability of ["tools", "json", "reasoning"]) {
    if (needs[capability] && !target.capabilities?.[capability]) return { eligible: false, reason: `missing_capability:${capability}` };
  }
  if (request.maxOutputTokens > target.maxOutputTokens) return { eligible: false, reason: "output_exceeds_model_limit" };
  if (request.estimatedInputTokens + request.maxOutputTokens > target.contextWindowTokens) return { eligible: false, reason: "context_exceeds_window" };
  const counted = request.estimatedInputTokens + (outputCountsTowardLimit ? request.maxOutputTokens : 0);
  if (limitTokens !== null && counted > limitTokens) return { eligible: false, reason: "exceeds_per_minute_allowance" };
  if (limitInputTokens !== null && request.estimatedInputTokens > limitInputTokens) return { eligible: false, reason: "exceeds_per_minute_input_allowance" };
  if (limitOutputTokens !== null && request.maxOutputTokens > limitOutputTokens) return { eligible: false, reason: "exceeds_per_minute_output_allowance" };
  return { eligible: true };
}
