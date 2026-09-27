import { compareRequests } from "./contracts.mjs";
import { parseRateLimitHeaders } from "./rate-limit-state.mjs";

/**
 * The quota ledger for one provider quota scope (e.g. one Groq organization,
 * whose limits every API key and every model call shares).
 *
 * Every Worker isolate, agent and coder run that uses the scope reserves
 * through one ledger, so they stop each believing the whole allowance is
 * theirs. It lives in one Durable Object per scope (single-threaded, so each
 * operation is atomic) and is plain logic over a JSON state, so it is tested
 * without a Cloudflare runtime.
 *
 *  - reserve: atomic and idempotent. The same request id always gets the same
 *    answer while its reservation lives; a retry never double-books.
 *  - reservations expire: a caller that dies without releasing cannot hold
 *    capacity for ever.
 *  - release reconciles with what the provider actually reported (the
 *    x-ratelimit-* headers of that response), and records refusals.
 *  - a request that cannot be served yet joins a waiting list ordered by
 *    latency class, then priority, then arrival. Capacity that a
 *    higher-ranked waiter could use now is held back for it, so a stream of
 *    small background calls cannot starve the answer a person is waiting on.
 *    A waiter that could not fit anyway holds nothing back.
 */

export const RESERVATION_TTL_MS = 120_000;
export const WAITING_TTL_MS = 60_000;
/** How soon to ask again when nothing is known about when capacity returns. */
export const POLL_MS = 1_000;

export function emptyLedgerState() {
  return { version: 1, models: {}, reservations: {}, waiting: {} };
}

function modelEntry(state, model) {
  state.models[model] ??= {
    limitRequests: null, limitTokens: null, remainingRequests: null, remainingTokens: null,
    resetRequestsAt: null, resetTokensAt: null, blockedUntil: null, blockedReason: null, observedAt: null,
  };
  return state.models[model];
}

/** Drops expired reservations and waiters, and windows that have reset. Mutates `state`. */
export function prune(state, now) {
  for (const [id, reservation] of Object.entries(state.reservations)) if (reservation.expiresAt <= now) delete state.reservations[id];
  for (const [id, waiter] of Object.entries(state.waiting)) if (waiter.expiresAt <= now) delete state.waiting[id];
  for (const entry of Object.values(state.models)) {
    if (entry.blockedUntil !== null && entry.blockedUntil <= now) { entry.blockedUntil = null; entry.blockedReason = null; }
    if (entry.resetTokensAt !== null && entry.resetTokensAt <= now) { entry.remainingTokens = entry.limitTokens; entry.resetTokensAt = null; }
    if (entry.resetRequestsAt !== null && entry.resetRequestsAt <= now) { entry.remainingRequests = entry.limitRequests; entry.resetRequestsAt = null; }
  }
  return state;
}

function reservedOn(state, model) {
  let tokens = 0;
  let requests = 0;
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.model !== model) continue;
    tokens += reservation.tokens;
    requests += 1;
  }
  return { tokens, requests };
}

/**
 * What `model` has left for new work right now, after live reservations.
 * Unknown allowances (no headers seen yet) are Infinity: unknown is not empty.
 */
function available(state, model, now) {
  const entry = state.models[model];
  if (!entry) return { tokens: Number.POSITIVE_INFINITY, requests: Number.POSITIVE_INFINITY, blockedMs: 0, resetMs: null };
  if (entry.blockedUntil !== null && entry.blockedUntil > now) return { tokens: 0, requests: 0, blockedMs: entry.blockedUntil - now, resetMs: entry.blockedUntil - now, reason: entry.blockedReason };
  const reserved = reservedOn(state, model);
  const tokens = entry.remainingTokens === null ? Number.POSITIVE_INFINITY : entry.remainingTokens - reserved.tokens;
  const requests = entry.remainingRequests === null ? Number.POSITIVE_INFINITY : entry.remainingRequests - reserved.requests;
  const resets = [entry.resetTokensAt, entry.resetRequestsAt].filter((at) => at !== null && at > now).map((at) => at - now);
  return { tokens, requests, blockedMs: 0, resetMs: resets.length ? Math.min(...resets) : null };
}

/**
 * Asks for capacity on the first candidate model that can take the request.
 *
 * @param {object} state Ledger state; mutated.
 * @param {{ requestId: string, models: string[], estimatedTokens: number, latencyClass?: string, priority?: number, ttlMs?: number }} request
 * @param {number} now
 * @returns {{ granted: true, model: string, expiresAt: number, replay?: true } | { granted: false, waitMs: number, reason: string, position: number }}
 */
export function reserve(state, request, now) {
  prune(state, now);
  const existing = state.reservations[request.requestId];
  if (existing) return { granted: true, model: existing.model, expiresAt: existing.expiresAt, replay: true };

  const me = {
    latencyClass: request.latencyClass ?? "TASK_CRITICAL", priority: request.priority ?? 0,
    enqueuedAt: state.waiting[request.requestId]?.registeredAt ?? now,
  };
  const ahead = Object.entries(state.waiting)
    .filter(([id, waiter]) => id !== request.requestId && compareRequests(waiter, me) < 0);

  let soonest = Number.POSITIVE_INFINITY;
  let reason = "capacity";
  for (const model of request.models) {
    const room = available(state, model, now);
    // Capacity a higher-ranked waiter could use right now is held for it.
    let heldTokens = 0;
    let heldRequests = 0;
    for (const [, waiter] of ahead) {
      if (!waiter.models.includes(model) || waiter.tokens > room.tokens - heldTokens || room.requests - heldRequests < 1) continue;
      heldTokens += waiter.tokens;
      heldRequests += 1;
    }
    const fits = room.requests - heldRequests >= 1 && request.estimatedTokens <= room.tokens - heldTokens;
    if (fits) {
      const expiresAt = now + (request.ttlMs ?? RESERVATION_TTL_MS);
      state.reservations[request.requestId] = { model, tokens: request.estimatedTokens, grantedAt: now, expiresAt };
      delete state.waiting[request.requestId];
      return { granted: true, model, expiresAt };
    }
    if (heldTokens > 0 || heldRequests > 0) reason = "held_for_higher_priority";
    else if (room.reason) reason = room.reason;
    soonest = Math.min(soonest, room.resetMs ?? POLL_MS);
  }

  state.waiting[request.requestId] = {
    models: [...request.models], tokens: request.estimatedTokens, latencyClass: me.latencyClass, priority: me.priority,
    registeredAt: me.enqueuedAt, enqueuedAt: me.enqueuedAt, expiresAt: now + WAITING_TTL_MS,
  };
  const position = Object.values(state.waiting).filter((waiter) => compareRequests(waiter, me) < 0).length + 1;
  return { granted: false, waitMs: Math.max(1, Math.ceil(soonest === Number.POSITIVE_INFINITY ? POLL_MS : soonest)), reason, position };
}

/** Records the capacity headers of any response for `model`. */
export function observe(state, model, headers, now) {
  const parsed = parseRateLimitHeaders(headers, now);
  const entry = modelEntry(state, model);
  for (const field of ["limitRequests", "limitTokens", "remainingRequests", "remainingTokens", "resetRequestsAt", "resetTokensAt"]) {
    if (parsed[field] !== null) entry[field] = parsed[field];
  }
  if (parsed.retryAfterAt !== null) block(entry, parsed.retryAfterAt, "retry_after");
  entry.observedAt = now;
  return entry;
}

function block(entry, until, reason) {
  if (entry.blockedUntil === null || until > entry.blockedUntil) {
    entry.blockedUntil = until;
    entry.blockedReason = reason;
  }
}

/**
 * Ends a reservation and reconciles the ledger with what the provider said.
 * The provider's own remaining-tokens header replaces Atlas's estimate: the
 * ledger never drifts further than one response from the truth.
 *
 * @param {{ requestId: string, model?: string, headers?: Headers | Record<string, string>, status?: number, retryAfterMs?: number | null, scope?: string }} outcome
 */
export function release(state, outcome, now) {
  const reservation = state.reservations[outcome.requestId];
  const model = outcome.model ?? reservation?.model;
  delete state.reservations[outcome.requestId];
  if (model && outcome.headers) observe(state, model, outcome.headers, now);
  if (model && outcome.status === 429) {
    const entry = modelEntry(state, model);
    const known = [entry.resetTokensAt, entry.resetRequestsAt].filter((at) => at !== null && at > now);
    const until = outcome.retryAfterMs != null ? now + outcome.retryAfterMs : known.length ? Math.min(...known) : now + 2_000;
    block(entry, until, outcome.scope === "daily" ? "daily_limit" : "rate_limit");
  }
  prune(state, now);
  return { released: Boolean(reservation) };
}

/** Withdraws a waiting request (cancelled, or served elsewhere). */
export function withdraw(state, requestId) {
  delete state.waiting[requestId];
  delete state.reservations[requestId];
}

/** When the owning Durable Object should wake to prune, or null when nothing is pending. */
export function nextExpiry(state) {
  const times = [...Object.values(state.reservations), ...Object.values(state.waiting)].map((item) => item.expiresAt);
  return times.length ? Math.min(...times) : null;
}

/** Metadata-only view for status pages: counts and times, never request content. */
export function ledgerSnapshot(state, now) {
  prune(state, now);
  return {
    models: Object.fromEntries(Object.entries(state.models).map(([model, entry]) => [model, { ...entry, reserved: reservedOn(state, model) }])),
    reservations: Object.keys(state.reservations).length,
    waiting: Object.values(state.waiting).sort(compareRequests).map((waiter) => ({ latencyClass: waiter.latencyClass, priority: waiter.priority, tokens: waiter.tokens })),
  };
}
