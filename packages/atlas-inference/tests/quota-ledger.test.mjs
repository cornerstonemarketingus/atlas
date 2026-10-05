import assert from "node:assert/strict";
import test from "node:test";
import { emptyLedgerState, ledgerSnapshot, nextExpiry, observeLedger, releaseReservation, reserveCapacity, withdrawRequest } from "../src/index.mjs";

// A 6,000 TPM model with 1,200 left, resetting in 10s: Groq's free tier mid-minute.
const groq = (remaining = "1200", reset = "10s") => new Headers({
  "x-ratelimit-limit-tokens": "6000", "x-ratelimit-remaining-tokens": remaining, "x-ratelimit-reset-tokens": reset,
  "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "990", "x-ratelimit-reset-requests": "2m",
});
const ask = (requestId, tokens, extra = {}) => ({ requestId, models: ["big"], estimatedTokens: tokens, ...extra });

test("an unknown model is not treated as empty", () => {
  const state = emptyLedgerState();
  assert.equal(reserveCapacity(state, ask("a", 50_000), 0).granted, true);
});

test("reservations count against what the provider said is left, across every caller", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq("5000"), 0);
  assert.equal(reserveCapacity(state, ask("isolate-1", 3_000), 0).granted, true);
  // A second isolate asking at the same moment sees the first one's reservation.
  const second = reserveCapacity(state, ask("isolate-2", 3_000), 0);
  assert.equal(second.granted, false);
  assert.equal(second.waitMs, 10_000);
});

test("reserve is idempotent: a retried request id never double-books", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq("5000"), 0);
  const first = reserveCapacity(state, ask("same", 3_000), 0);
  const again = reserveCapacity(state, ask("same", 3_000), 5);
  assert.equal(again.granted, true);
  assert.equal(again.replay, true);
  assert.equal(again.expiresAt, first.expiresAt);
  assert.equal(ledgerSnapshot(state, 5).models.big.reserved.tokens, 3_000);
});

test("an abandoned reservation expires and frees its capacity", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq("5000", "10m"), 0);
  reserveCapacity(state, ask("crashed", 4_000, { ttlMs: 30_000 }), 0);
  assert.equal(reserveCapacity(state, ask("next", 4_000), 1_000).granted, false);
  assert.equal(nextExpiry(state) !== null, true);
  assert.equal(reserveCapacity(state, ask("next", 4_000), 30_001).granted, true);
});

test("release reconciles with the provider's own numbers, not Atlas's estimate", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq("5000"), 0);
  reserveCapacity(state, ask("r1", 1_000), 0);
  // The call actually used far more than estimated; the headers say so.
  releaseReservation(state, { requestId: "r1", headers: groq("200") }, 100);
  assert.equal(ledgerSnapshot(state, 100).models.big.remainingTokens, 200);
  assert.equal(ledgerSnapshot(state, 100).reservations, 0);
  assert.equal(reserveCapacity(state, ask("r2", 1_000), 100).granted, false);
});

test("the window refills at its reset time", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq("0", "10s"), 0);
  assert.equal(reserveCapacity(state, ask("a", 1_000), 9_999).granted, false);
  assert.equal(reserveCapacity(state, ask("a", 1_000), 10_000).granted, true);
});

test("a 429 blocks the model until its stated wait; a daily block is not shortened", () => {
  const state = emptyLedgerState();
  reserveCapacity(state, ask("r", 100), 0);
  releaseReservation(state, { requestId: "r", status: 429, retryAfterMs: 600_000, scope: "daily" }, 0);
  const denied = reserveCapacity(state, ask("next", 100), 1_000);
  assert.equal(denied.granted, false);
  assert.equal(denied.reason, "daily_limit");
  releaseReservation(state, { requestId: "x", model: "big", status: 429, retryAfterMs: 1_000 }, 2_000);
  assert.equal(reserveCapacity(state, ask("next", 100), 5_000).granted, false, "the longer daily block still holds");
});

test("capacity a higher-priority waiter can use is held for it; background work cannot starve the person waiting", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq("0", "10s"), 0);
  // The final answer a person is waiting on asks first and must wait for the reset.
  assert.equal(reserveCapacity(state, ask("synthesis", 1_000, { latencyClass: "INTERACTIVE", priority: 5 }), 0).granted, false);
  // After the reset, a background job asks before the answer polls again.
  const background = reserveCapacity(state, ask("indexing", 5_500, { latencyClass: "BACKGROUND" }), 10_000);
  assert.equal(background.granted, false);
  assert.equal(background.reason, "held_for_higher_priority");
  assert.equal(reserveCapacity(state, ask("synthesis", 1_000, { latencyClass: "INTERACTIVE", priority: 5 }), 10_001).granted, true);
  // With the answer served, the background job fits in what is left.
  assert.equal(reserveCapacity(state, ask("small-bg", 4_000, { latencyClass: "BACKGROUND" }), 10_002).granted, true);
});

test("a higher-priority waiter that cannot fit anyway holds nothing back", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq("2000", "10s"), 0);
  assert.equal(reserveCapacity(state, ask("huge", 5_000, { latencyClass: "INTERACTIVE" }), 0).granted, false);
  assert.equal(reserveCapacity(state, ask("small", 1_000, { latencyClass: "BACKGROUND" }), 1).granted, true);
});

test("the next candidate model is used when the first cannot take it", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq("0", "40s"), 0);
  const granted = reserveCapacity(state, { requestId: "r", models: ["big", "small"], estimatedTokens: 1_000 }, 0);
  assert.deepEqual([granted.granted, granted.model], [true, "small"]);
});

test("waiters and withdrawals: a cancelled request leaves no trace", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq("0", "10s"), 0);
  const denied = reserveCapacity(state, ask("w", 100), 0);
  assert.equal(denied.position, 1);
  assert.equal(ledgerSnapshot(state, 0).waiting.length, 1);
  withdrawRequest(state, "w");
  assert.equal(ledgerSnapshot(state, 0).waiting.length, 0);
});

test("the snapshot is metadata only and the state survives JSON (Durable Object storage)", () => {
  const state = emptyLedgerState();
  observeLedger(state, "big", groq(), 0);
  reserveCapacity(state, ask("secret-request-id", 100), 0);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(reserveCapacity(restored, ask("secret-request-id", 100), 1).replay, true);
  assert.doesNotMatch(JSON.stringify(ledgerSnapshot(state, 0)), /secret-request-id/u);
});

test("a billing, key or permission failure disables the whole account scope, including models never tried", () => {
  for (const kind of ["BILLING", "AUTHENTICATION", "PERMISSION"]) {
    const state = emptyLedgerState();
    assert.equal(reserveCapacity(state, ask("a", 100, { models: ["one", "two"] }), 0).granted, true);
    releaseReservation(state, { requestId: "a", model: "one", status: 429, kind }, 0);
    const refused = reserveCapacity(state, ask("b", 100, { models: ["two", "three"] }), 1_000);
    assert.deepEqual([refused.granted, refused.permanent, refused.kind, refused.reason], [false, true, kind, "account_disabled"], kind);
    assert.equal(Object.keys(state.waiting).length, 0, "nobody queues for an account that cannot serve");
    assert.equal(ledgerSnapshot(state, 1_000).account.kind, kind);
  }
});

test("a model-scoped failure leaves the account and its other models alone; success clears an account block", () => {
  const state = emptyLedgerState();
  reserveCapacity(state, ask("a", 100, { models: ["one"] }), 0);
  releaseReservation(state, { requestId: "a", model: "one", status: 404, kind: "MODEL_NOT_FOUND" }, 0);
  assert.equal(reserveCapacity(state, ask("b", 100, { models: ["one", "two"] }), 1).model, "two", "only the missing model is skipped");
  releaseReservation(state, { requestId: "b", model: "two", status: 402, kind: "BILLING" }, 2);
  assert.equal(reserveCapacity(state, ask("c", 100, { models: ["two"] }), 3).permanent, true);
  releaseReservation(state, { requestId: "x", model: "two", status: 200, kind: null }, 4);
  assert.equal(ledgerSnapshot(state, 5).account, null);
  assert.equal(reserveCapacity(state, ask("d", 100, { models: ["two"] }), 5).granted, true, "a success restores the account and the model that served it");
  assert.equal(reserveCapacity(state, ask("e", 100, { models: ["one"] }), 6).granted, false, "the model that does not exist stays disabled");
});

test("an account block ends after its cooldown, so the owner's fix is noticed without a restart", () => {
  const state = emptyLedgerState();
  reserveCapacity(state, ask("a", 100), 0);
  releaseReservation(state, { requestId: "a", model: "big", status: 402, kind: "BILLING" }, 0);
  assert.equal(reserveCapacity(state, ask("b", 100), 3_599_000).permanent, true);
  assert.equal(reserveCapacity(state, ask("c", 100, { models: ["other"] }), 3_600_001).granted, true);
});

test("a request bigger than a model's whole allowance is never queued for it; another model that fits is used", () => {
  const state = emptyLedgerState();
  observeLedger(state, "small", groq("5000"), 0); // limit 6000 tokens
  const refused = reserveCapacity(state, ask("a", 18_000, { models: ["small"] }), 0);
  assert.deepEqual([refused.granted, refused.permanent, refused.kind, refused.reason, refused.waitMs], [false, true, "CAPACITY_EXCEEDED", "request_exceeds_allowance", 0]);
  assert.equal(Object.keys(state.waiting).length, 0);
  assert.equal(reserveCapacity(state, ask("b", 18_000, { models: ["small", "large"] }), 0).model, "large");
  assert.equal(reserveCapacity(state, ask("c", 5_000, { models: ["small"] }), 0).granted, true, "a request that fits is unaffected");
});

test("an unobserved model admits one request at a time until a response teaches the ledger its allowance", () => {
  const state = emptyLedgerState();
  assert.equal(reserveCapacity(state, ask("first", 1_000), 0).granted, true);
  const second = reserveCapacity(state, ask("second", 1_000), 0);
  assert.deepEqual([second.granted, second.reason, second.waitMs], [false, "learning_capacity", 1_000]);
  observeLedger(state, "big", groq("5000"), 10); // the first response's headers arrive
  assert.equal(reserveCapacity(state, ask("second", 1_000), 20).granted, true, "once known, requests are sized by the real allowance");
  assert.equal(reserveCapacity(state, ask("third", 4_000), 20).granted, false, "and still cannot oversubscribe it");
});
