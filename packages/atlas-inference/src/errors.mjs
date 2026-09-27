import { retryAfterHeaderMs, suggestedWaitMs } from "./durations.mjs";

/**
 * One vocabulary for why a model call did not produce inference, whatever
 * provider it went to. Different failures need different recovery: a 429 is
 * "not now", a 401 is "not ever until someone fixes the key", and an empty
 * HTTP 200 is neither success nor an HTTP error. Treating them alike either
 * hammers a provider that cannot help or gives up on one that would have.
 */
export const InferenceErrorKind = Object.freeze({
  RATE_LIMIT: "RATE_LIMIT",
  AUTHENTICATION: "AUTHENTICATION",
  PERMISSION: "PERMISSION",
  BILLING: "BILLING",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  CONTEXT_TOO_LARGE: "CONTEXT_TOO_LARGE",
  TIMEOUT: "TIMEOUT",
  SERVER_ERROR: "SERVER_ERROR",
  CAPACITY: "CAPACITY",
  NETWORK: "NETWORK",
  EMPTY_MODEL_RESPONSE: "EMPTY_MODEL_RESPONSE",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
});

const K = InferenceErrorKind;

/**
 * What each kind means for recovery.
 * - `retrySameTarget`: asking the same model again can succeed (after `wait`).
 * - `alternateTarget`: another model or provider can take the request.
 * - `cooldownTarget`: stop sending to this target for a while; it is not
 *   going to help and every extra request is wasted (or worsens the limit).
 * - `disableTarget`: the target cannot serve this deployment until its
 *   configuration changes (bad key, model gone, no permission).
 * - `reshapeRequest`: the request itself must change (too large for the
 *   target); retrying it unchanged is guaranteed to fail.
 */
const RECOVERY = Object.freeze({
  [K.RATE_LIMIT]: { retrySameTarget: true, wait: true, alternateTarget: true, cooldownTarget: true, disableTarget: false, reshapeRequest: false },
  [K.CAPACITY]: { retrySameTarget: true, wait: true, alternateTarget: true, cooldownTarget: true, disableTarget: false, reshapeRequest: false },
  [K.SERVER_ERROR]: { retrySameTarget: true, wait: true, alternateTarget: true, cooldownTarget: true, disableTarget: false, reshapeRequest: false },
  [K.TIMEOUT]: { retrySameTarget: true, wait: false, alternateTarget: true, cooldownTarget: true, disableTarget: false, reshapeRequest: false },
  [K.NETWORK]: { retrySameTarget: true, wait: true, alternateTarget: true, cooldownTarget: true, disableTarget: false, reshapeRequest: false },
  [K.EMPTY_MODEL_RESPONSE]: { retrySameTarget: true, wait: false, alternateTarget: true, cooldownTarget: false, disableTarget: false, reshapeRequest: false },
  [K.INVALID_RESPONSE]: { retrySameTarget: true, wait: false, alternateTarget: true, cooldownTarget: false, disableTarget: false, reshapeRequest: false },
  [K.CONTEXT_TOO_LARGE]: { retrySameTarget: false, wait: false, alternateTarget: true, cooldownTarget: false, disableTarget: false, reshapeRequest: true },
  [K.AUTHENTICATION]: { retrySameTarget: false, wait: false, alternateTarget: true, cooldownTarget: false, disableTarget: true, reshapeRequest: false },
  [K.PERMISSION]: { retrySameTarget: false, wait: false, alternateTarget: true, cooldownTarget: false, disableTarget: true, reshapeRequest: false },
  [K.BILLING]: { retrySameTarget: false, wait: false, alternateTarget: true, cooldownTarget: false, disableTarget: true, reshapeRequest: false },
  [K.MODEL_NOT_FOUND]: { retrySameTarget: false, wait: false, alternateTarget: true, cooldownTarget: false, disableTarget: true, reshapeRequest: false },
  [K.CANCELLED]: { retrySameTarget: false, wait: false, alternateTarget: false, cooldownTarget: false, disableTarget: false, reshapeRequest: false },
  [K.UNKNOWN]: { retrySameTarget: false, wait: false, alternateTarget: true, cooldownTarget: false, disableTarget: false, reshapeRequest: false },
});

export function recoveryFor(kind) {
  return RECOVERY[kind] ?? RECOVERY[K.UNKNOWN];
}

/** Kinds that say "not now" rather than "not ever". */
export function isTransient(kind) {
  const recovery = recoveryFor(kind);
  return recovery.retrySameTarget && !recovery.disableTarget;
}

const CONTEXT_PATTERN = /context[_ ]length|maximum context|context window|too many tokens|reduce the length|request too large|prompt is too long|input is too long/iu;
// Deliberately not the bare word "billing": Groq's ordinary 429 body links to
// console.groq.com/settings/billing, and a rate limit is not a billing failure.
const BILLING_PATTERN = /insufficient[_ ]quota|exceeded your current quota|payment required|credit balance is too low/iu;
const MODEL_PATTERN = /model[_ ]not[_ ]found|model_decommissioned|decommissioned|does not exist|unknown model|no such model|not supported model/iu;
const CAPACITY_PATTERN = /over capacity|overloaded|capacity|temporarily unavailable|try again later/iu;

/**
 * Classifies a non-2xx model response. `body` is used only to pick the kind
 * and a stated wait; it is never copied into the result, because providers
 * echo the prompt back in error bodies.
 *
 * @param {{ status: number, body?: string, headers?: Headers | Record<string, string> }} response
 * @returns {{ kind: string, status: number, retryAfterMs: number | null, scope?: string }}
 */
export function classifyHttpFailure({ status, body = "", headers }) {
  const text = String(body ?? "").slice(0, 4_000);
  const retryAfterMs = retryAfterHeaderMs(headers) ?? suggestedWaitMs(text);
  const result = (kind, extra = {}) => ({ kind, status, retryAfterMs, ...extra });
  if (status === 401) return result(K.AUTHENTICATION);
  if (status === 402 || (status !== 400 && BILLING_PATTERN.test(text))) return result(K.BILLING);
  if (status === 403) return result(K.PERMISSION);
  if (status === 404 || (status === 400 && MODEL_PATTERN.test(text))) return result(K.MODEL_NOT_FOUND);
  // Groq answers a request bigger than the whole per-minute allowance with
  // 413 "Request too large ... tokens per minute": no wait makes it fit this
  // target, but another target, or a smaller request, can.
  if (status === 413) return result(K.CONTEXT_TOO_LARGE, { scope: /per minute|TPM/iu.test(text) ? "rate_allowance" : "context_window" });
  if (status === 400 && CONTEXT_PATTERN.test(text)) return result(K.CONTEXT_TOO_LARGE, { scope: "context_window" });
  if (status === 429) {
    const daily = /per day|\b(?:TPD|RPD)\b/u.test(text);
    return result(K.RATE_LIMIT, { scope: daily ? "daily" : "minute" });
  }
  if (status === 408 || status === 504) return result(K.TIMEOUT);
  if (status === 529 || (status === 503 && CAPACITY_PATTERN.test(text))) return result(K.CAPACITY);
  if (status >= 500) return result(K.SERVER_ERROR);
  return result(K.UNKNOWN);
}

/** Classifies a thrown fetch failure (no HTTP response at all). */
export function classifyThrown(error, { cancelled = false } = {}) {
  if (cancelled) return { kind: K.CANCELLED, status: null, retryAfterMs: null };
  const name = error && typeof error === "object" ? error.name : "";
  if (name === "TimeoutError") return { kind: K.TIMEOUT, status: null, retryAfterMs: null };
  if (name === "AbortError") return { kind: K.CANCELLED, status: null, retryAfterMs: null };
  return { kind: K.NETWORK, status: null, retryAfterMs: null };
}

/**
 * Classifies an HTTP 200 chat-completions body that may carry nothing.
 * Returns null when it is usable: words, or at least one tool call.
 */
export function classifyCompletion({ payload, text = "", toolCallCount = 0, parsed = true }) {
  if (!parsed) return { kind: K.INVALID_RESPONSE, status: 200, retryAfterMs: null };
  if (String(text).trim() || toolCallCount > 0) return null;
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  return { kind: K.EMPTY_MODEL_RESPONSE, status: 200, retryAfterMs: null, finishReason, noChoices: payload !== undefined && !choice };
}

/** A user-facing sentence for a kind: plain words, no status codes or provider jargon. */
export function describeForPerson(kind) {
  switch (kind) {
    case K.RATE_LIMIT:
    case K.CAPACITY: return "Model capacity is temporarily full.";
    case K.TIMEOUT: return "The model took too long to answer.";
    case K.NETWORK: return "The model service could not be reached.";
    case K.SERVER_ERROR: return "The model service had a temporary problem.";
    case K.EMPTY_MODEL_RESPONSE:
    case K.INVALID_RESPONSE: return "The model returned an unusable reply.";
    case K.CONTEXT_TOO_LARGE: return "The request was too large for the model.";
    case K.AUTHENTICATION: return "The model key was rejected. Check the key in Connections.";
    case K.PERMISSION: return "This model is not permitted for the configured account.";
    case K.BILLING: return "The model account is out of credit or quota.";
    case K.MODEL_NOT_FOUND: return "The configured model is not available from the provider.";
    case K.CANCELLED: return "The request was cancelled.";
    default: return "The model could not answer.";
  }
}
