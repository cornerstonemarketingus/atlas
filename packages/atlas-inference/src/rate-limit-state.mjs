import { headerValue, parseDurationMs, retryAfterHeaderMs } from "./durations.mjs";

/**
 * What Atlas knows about each inference target's capacity, before it sends.
 *
 * Providers say how much of their allowance is left on every response
 * (`x-ratelimit-*`) and how long to wait on every refusal (`retry-after`).
 * Ignoring that and discovering the limit by being refused wastes a request,
 * and on a shared per-minute allowance a refused request can itself push the
 * reset further out. This records what was said, per target, and answers one
 * question before each request: can this target take it now, and if not, how
 * long until it can?
 *
 * The state is advisory and in-memory. It is shared by everything in one
 * process (every agent in a hosted chat reply, every turn of a coder run), so
 * one agent learning a target is exhausted spares the others the refusal.
 * Durable, cross-process state is a later layer; nothing here assumes it.
 */

/** A target is one model on one endpoint: limits are per model on Groq. */
export function targetKey({ provider, baseUrl, model }) {
  let host = provider ?? "";
  if (baseUrl) {
    try { host = new URL(baseUrl).host; } catch { host = String(baseUrl); }
  }
  return `${host}/${model ?? ""}`;
}

/**
 * Reads the capacity headers OpenAI-compatible providers send (Groq, OpenAI,
 * vLLM with a limiter, and others use the same names). Missing headers are
 * null, never zero: "unknown" must not read as "exhausted".
 */
export function parseRateLimitHeaders(headers, now = Date.now()) {
  const integer = (name) => {
    const value = Number.parseInt(headerValue(headers, name), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const resetAt = (name) => {
    const ms = parseDurationMs(headerValue(headers, name));
    return ms === null ? null : now + ms;
  };
  const retryAfter = retryAfterHeaderMs(headers);
  return {
    limitRequests: integer("x-ratelimit-limit-requests"),
    limitTokens: integer("x-ratelimit-limit-tokens"),
    remainingRequests: integer("x-ratelimit-remaining-requests"),
    remainingTokens: integer("x-ratelimit-remaining-tokens"),
    resetRequestsAt: resetAt("x-ratelimit-reset-requests"),
    resetTokensAt: resetAt("x-ratelimit-reset-tokens"),
    retryAfterAt: retryAfter === null ? null : now + retryAfter,
  };
}

/** Rough upper bound for tokens in a JSON chat request. Over-estimating costs a short wait; under-estimating costs a refusal. */
export function estimateRequestTokens(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return Math.ceil(new TextEncoder().encode(text).length / 3);
}

export class ProviderCapacityState {
  #targets = new Map();
  #now;

  /** @param {{ now?: () => number }} [options] */
  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  #entry(key) {
    let entry = this.#targets.get(key);
    if (!entry) {
      entry = {
        limitRequests: null, limitTokens: null, remainingRequests: null, remainingTokens: null,
        resetRequestsAt: null, resetTokensAt: null, blockedUntil: null, blockedReason: null,
        inFlight: 0, tokensInFlight: 0, lastObservedAt: null,
      };
      this.#targets.set(key, entry);
    }
    return entry;
  }

  /** Records the capacity headers from any response, success or refusal. */
  observe(key, headers) {
    const parsed = parseRateLimitHeaders(headers, this.#now());
    const entry = this.#entry(key);
    for (const field of ["limitRequests", "limitTokens", "remainingRequests", "remainingTokens", "resetRequestsAt", "resetTokensAt"]) {
      if (parsed[field] !== null) entry[field] = parsed[field];
    }
    if (parsed.retryAfterAt !== null) this.#block(entry, parsed.retryAfterAt, "retry_after");
    entry.lastObservedAt = this.#now();
    return this.snapshot(key);
  }

  /**
   * Records a refusal. A stated wait blocks the target until then; without
   * one, the known reset of whichever allowance ran out is used, and failing
   * that a short default, so the next request does not go straight back.
   */
  rateLimited(key, { retryAfterMs = null, scope = "minute" } = {}) {
    const entry = this.#entry(key);
    const now = this.#now();
    const until = retryAfterMs !== null ? now + retryAfterMs : this.#likelyReset(entry, now) ?? now + 2_000;
    this.#block(entry, until, scope === "daily" ? "daily_limit" : "rate_limit");
    return this.snapshot(key);
  }

  /**
   * The reset of the allowance that most likely ran out: the one reported
   * empty, else tokens (the per-minute token allowance is what agents hit),
   * else requests.
   */
  #likelyReset(entry, now) {
    const future = (at) => (at !== null && at > now ? at : null);
    if (entry.remainingRequests === 0 && future(entry.resetRequestsAt)) return entry.resetRequestsAt;
    return future(entry.resetTokensAt) ?? future(entry.resetRequestsAt);
  }

  #block(entry, until, reason) {
    if (entry.blockedUntil === null || until > entry.blockedUntil) {
      entry.blockedUntil = until;
      entry.blockedReason = reason;
    }
  }

  /**
   * Whether `key` can take a request of `estimatedTokens` now.
   * @returns {{ ok: true } | { ok: false, waitMs: number, reason: string }}
   */
  check(key, estimatedTokens = 0) {
    const entry = this.#targets.get(key);
    if (!entry) return { ok: true };
    const now = this.#now();
    if (entry.blockedUntil !== null) {
      if (entry.blockedUntil > now) return { ok: false, waitMs: entry.blockedUntil - now, reason: entry.blockedReason ?? "rate_limit" };
      entry.blockedUntil = null;
      entry.blockedReason = null;
    }
    if (entry.remainingRequests !== null && entry.resetRequestsAt !== null && entry.resetRequestsAt > now
      && entry.remainingRequests - entry.inFlight <= 0) {
      return { ok: false, waitMs: entry.resetRequestsAt - now, reason: "requests_exhausted" };
    }
    if (entry.remainingTokens !== null && entry.resetTokensAt !== null && entry.resetTokensAt > now
      && estimatedTokens > entry.remainingTokens - entry.tokensInFlight) {
      // A request larger than the whole allowance never fits by waiting.
      if (entry.limitTokens !== null && estimatedTokens > entry.limitTokens) return { ok: false, waitMs: Number.POSITIVE_INFINITY, reason: "larger_than_allowance" };
      return { ok: false, waitMs: entry.resetTokensAt - now, reason: "tokens_exhausted" };
    }
    return { ok: true };
  }

  /** Marks a request as sent; the returned function marks it finished. */
  begin(key, estimatedTokens = 0) {
    const entry = this.#entry(key);
    entry.inFlight += 1;
    entry.tokensInFlight += estimatedTokens;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.tokensInFlight = Math.max(0, entry.tokensInFlight - estimatedTokens);
    };
  }

  /** A copy of what is known about one target, for routing and diagnostics. */
  snapshot(key) {
    const entry = this.#targets.get(key);
    return entry ? { key, ...entry } : null;
  }

  keys() {
    return [...this.#targets.keys()];
  }
}

/** Earlier name, kept so existing imports keep working. */
export const RateLimitState = ProviderCapacityState;
