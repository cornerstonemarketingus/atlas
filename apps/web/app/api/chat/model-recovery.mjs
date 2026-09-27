/** Temporary, scoped recovery evidence. No bodies, prompts, URLs or credentials enter telemetry. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CATEGORIES = new Set(["rpm", "rpd", "tpm", "tpd", "input_tokens", "output_tokens", "concurrency", "capacity"]);
const numberHeader = (headers, name) => {
  const raw = headers.get(name);
  return raw !== null && /^\d+(?:\.\d+)?$/u.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : null;
};

/** Groq duration headers can contain multiple units, e.g. 2m59.5s. */
export function resetMs(value) {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/u.test(value)) return null;
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const total = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gu)].reduce((sum, match) => sum + Number(match[1]) * units[match[2]], 0);
  return Number.isFinite(total) ? Math.ceil(total) : null;
}

export function rateLimitEvidence(headers, { now = Date.now(), attempt = 1, random = Math.random, inputTokenEstimate = 0, outputTokenEstimate = 0 } = {}) {
  const after = headers.get("retry-after");
  const seconds = numberHeader(headers, "retry-after");
  const date = after && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /u.test(after) && seconds === null ? Date.parse(after) : NaN;
  const retryAfter = seconds !== null ? Math.ceil(seconds * 1000) : Number.isFinite(date) ? Math.max(0, date - now) : null;
  const requestReset = resetMs(headers.get("x-ratelimit-reset-requests"));
  const tokenReset = resetMs(headers.get("x-ratelimit-reset-tokens"));
  const remainingRequests = numberHeader(headers, "x-ratelimit-remaining-requests");
  const remainingTokens = numberHeader(headers, "x-ratelimit-remaining-tokens");
  const tokenExhausted = remainingTokens !== null && remainingTokens < Math.max(1, inputTokenEstimate + outputTokenEstimate);
  const dailyRequests = numberHeader(headers, "x-ratelimit-remaining-requests-day");
  const dailyTokens = numberHeader(headers, "x-ratelimit-remaining-tokens-day");
  const dailyReset = Math.max(resetMs(headers.get("x-ratelimit-reset-requests-day")) ?? 0, resetMs(headers.get("x-ratelimit-reset-tokens-day")) ?? 0);
  const named = headers.get("x-ratelimit-category");
  const category = CATEGORIES.has(named) ? named : dailyTokens === 0 ? "tpd" : dailyRequests === 0 ? "rpd"
    : tokenExhausted ? "tokens" : remainingRequests === 0 ? "requests" : "unknown";
  const resets = [retryAfter, dailyReset || null];
  if (tokenExhausted) resets.push(tokenReset);
  if (remainingRequests === 0) resets.push(requestReset);
  // If no exhausted dimension is named, preserve both reset hints rather than
  // assuming that the first header describes the blocking limit.
  if (!tokenExhausted && remainingRequests !== 0 && retryAfter === null) resets.push(tokenReset, requestReset);
  const authoritative = resets.filter((value) => value !== null);
  const backoff = Math.min(8000, 1000 * 2 ** Math.min(3, Math.max(0, attempt - 1))) * (0.5 + random() * 0.5);
  const waitMs = authoritative.length ? Math.max(...authoritative) : Math.ceil(backoff);
  return { retryAfterMs: retryAfter, requestResetMs: requestReset, tokenResetMs: tokenReset,
    remainingRequests, remainingTokens, category, waitMs,
    scope: headers.get("x-ratelimit-scope") === "provider" ? "provider" : "model",
    authoritative: authoritative.length > 0 };
}

export function retryAfterMs(headers) {
  return rateLimitEvidence(headers, { random: () => 1, attempt: 2 }).waitMs;
}

function targetKey(target, providerWide = false) {
  return JSON.stringify([target.provider ?? new URL(target.baseUrl).origin, providerWide ? new URL(target.baseUrl).origin : target.baseUrl, providerWide ? "*" : target.model]);
}

export class ModelRecoveryState {
  #limits = new Map();
  #events = [];
  #failures = new Map();
  constructor({ now = () => Date.now(), random = Math.random } = {}) { this.now = now; this.random = random; }
  availability(target) {
    const entries = [this.#limits.get(targetKey(target)), this.#limits.get(targetKey(target, true))].filter(Boolean);
    const until = Math.max(0, ...entries.map((entry) => entry.until));
    return { available: until <= this.now(), until };
  }
  record(target, status, headers, context = {}) {
    const key = targetKey(target);
    const attempt = (this.#failures.get(key) ?? 0) + 1;
    this.#failures.delete(key);
    this.#failures.set(key, attempt);
    if (this.#failures.size > 128) this.#failures.delete(this.#failures.keys().next().value);
    const evidence = rateLimitEvidence(headers, { now: this.now(), attempt, random: this.random,
      inputTokenEstimate: context.inputTokenEstimate ?? 0, outputTokenEstimate: context.outputTokenEstimate ?? 0 });
    const providerWide = evidence.scope === "provider" || target.rateLimitScope === "provider";
    const daily = ["rpd", "tpd"].includes(evidence.category);
    // Unknown daily reset gets a conservative temporary circuit, never a short retry.
    const delay = daily && !evidence.authoritative ? 86_400_000 : evidence.waitMs;
    const limitKey = targetKey(target, providerWide);
    const until = Math.max(this.#limits.get(limitKey)?.until ?? 0, this.now() + delay);
    this.#limits.delete(limitKey);
    this.#limits.set(limitKey, { until });
    if (this.#limits.size > 128) this.#limits.delete(this.#limits.keys().next().value);
    const event = { type: "model_recovery", targetId: target.id, provider: target.provider, model: target.model,
      timestamp: new Date(this.now()).toISOString(), httpStatus: status, ...evidence,
      category: status === 429 ? evidence.category : status === null ? "unavailable" : "capacity",
      scope: providerWide ? "provider" : "model", limitedUntil: until, attempt,
      turnId: context.turnId ?? null, taskId: context.taskId ?? null,
      inputTokenEstimate: context.inputTokenEstimate ?? null, outputTokenEstimate: context.outputTokenEstimate ?? null };
    this.#events.push(event);
    if (this.#events.length > 128) this.#events.shift();
    return structuredClone(event);
  }
  success(target) { this.#failures.delete(targetKey(target)); }
  history() { return structuredClone(this.#events); }
}

// Best-effort warm-worker cache. Scope is supplied only after authentication;
// never share this across tenants. Cold starts intentionally forget cooldowns.
const scopes = new Map();
export function recoveryForScope(scope) {
  if (!scope) return new ModelRecoveryState();
  const existing = scopes.get(scope);
  scopes.delete(scope);
  const state = existing ?? new ModelRecoveryState();
  scopes.set(scope, state);
  if (scopes.size > 128) scopes.delete(scopes.keys().next().value);
  return state;
}

/** Legacy choices are already operator-authorized; new targets require explicit policy and known prices. */
export function eligibleTargets(endpoint, { tools, turns, maxTokens = 2048 } = {}) {
  const base = new URL(endpoint.baseUrl);
  const local = LOOPBACK.has(base.hostname);
  const legacy = { ...endpoint, provider: base.origin === "https://api.groq.com" ? "groq" : "openai-compatible", local,
    policyAllowed: true, legacy: true, capabilities: {} };
  let targets = [{ ...legacy, id: "primary" }, ...(endpoint.fallbackModel ? [{ ...legacy, id: "fallback", model: endpoint.fallbackModel }] : []), ...(endpoint.targets ?? []).map((target) => ({ ...target }))];
  if (endpoint.targetOrder) targets.sort((a, b) => endpoint.targetOrder.indexOf(a.id) - endpoint.targetOrder.indexOf(b.id));
  const inputTokenEstimate = Math.ceil(JSON.stringify({ messages: turns, tools }).length / 4);
  const vision = turns.some((turn) => Array.isArray(turn.content) && turn.content.some((part) => ["image_url", "input_image"].includes(part?.type)));
  const seen = new Set();
  targets = targets.filter((target) => {
    const key = targetKey(target);
    if (seen.has(key)) return false;
    if (!target.policyAllowed || target.credentialAvailable === false) return false;
    if (endpoint.routingPolicy === "LOCAL_ONLY" && !target.local) return false;
    const caps = target.capabilities ?? {};
    if (!target.legacy && ((tools?.length && caps.toolCalls !== true) || (vision && caps.vision !== true))) return false;
    if (caps.contextTokens !== undefined && caps.contextTokens < inputTokenEstimate + maxTokens) return false;
    if (caps.maxOutputTokens !== undefined && caps.maxOutputTokens < maxTokens) return false;
    if (!target.legacy && !target.cost) return false;
    target.estimatedCostMicroUsd = target.legacy ? null : Math.ceil((inputTokenEstimate * target.cost.inputMicroUsdPerMillion + maxTokens * target.cost.outputMicroUsdPerMillion) / 1_000_000);
    if (!target.legacy && target.estimatedCostMicroUsd > 0 && (!endpoint.allowPaidRecovery || !endpoint.recoveryBudget
      || target.estimatedCostMicroUsd > endpoint.recoveryBudget.maxCostMicroUsd - endpoint.recoveryBudget.spentMicroUsd)) return false;
    seen.add(key);
    return true;
  });
  if (endpoint.routingPolicy === "PREFER_LOCAL") targets.sort((a, b) => Number(b.local) - Number(a.local));
  if (endpoint.routingPolicy === "BEST_AVAILABLE") targets.sort((a, b) => (b.reliability ?? -1) - (a.reliability ?? -1));
  return { targets, inputTokenEstimate };
}
