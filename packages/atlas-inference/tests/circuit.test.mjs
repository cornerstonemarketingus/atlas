import assert from "node:assert/strict";
import test from "node:test";
import {
  CIRCUIT, InferenceErrorKind as K, TargetHealth as H, admitToTarget, effectiveHealth, emptyLedgerState, initialHealth,
  ledgerSnapshot, recordOutcome, releaseReservation, reserveCapacity,
} from "../src/index.mjs";

test("two transient failures degrade a target, four open it, one success heals it", () => {
  const health = initialHealth();
  assert.equal(recordOutcome(health, K.SERVER_ERROR, 0), null);
  assert.deepEqual(recordOutcome(health, K.TIMEOUT, 1), { from: H.HEALTHY, to: H.DEGRADED });
  assert.equal(admitToTarget(health, "r", 2).allowed, true, "degraded still serves");
  recordOutcome(health, K.NETWORK, 3);
  assert.deepEqual(recordOutcome(health, K.SERVER_ERROR, 4), { from: H.DEGRADED, to: H.OPEN });
  assert.deepEqual(admitToTarget(health, "r", 5), { allowed: false, waitMs: CIRCUIT.baseCooldownMs - 1, reason: "target_open" });
  // Cooldown over: exactly one probe.
  const at = 4 + CIRCUIT.baseCooldownMs;
  assert.equal(effectiveHealth(health, at).state, H.PROBING);
  assert.deepEqual(recordOutcome(health, null, at), { from: H.PROBING, to: H.HEALTHY });
  assert.equal(health.consecutiveFailures, 0);
});

test("a failed probe reopens with a doubled cooldown, up to the ceiling", () => {
  const health = initialHealth();
  for (let index = 0; index < CIRCUIT.openAfter; index += 1) recordOutcome(health, K.SERVER_ERROR, 0);
  let now = CIRCUIT.baseCooldownMs;
  let expected = CIRCUIT.baseCooldownMs;
  for (let round = 0; round < 8; round += 1) {
    assert.deepEqual(recordOutcome(health, K.TIMEOUT, now), { from: H.PROBING, to: H.OPEN });
    expected = Math.min(expected * 2, CIRCUIT.maxCooldownMs);
    assert.equal(health.openUntil - now, expected);
    now = health.openUntil;
  }
  assert.equal(health.cooldownMs, CIRCUIT.maxCooldownMs);
});

test("configuration failures disable the target at once, with no retry loop", () => {
  for (const kind of [K.AUTHENTICATION, K.PERMISSION, K.BILLING, K.MODEL_NOT_FOUND]) {
    const health = initialHealth();
    assert.deepEqual(recordOutcome(health, kind, 0), { from: H.HEALTHY, to: H.OPEN }, kind);
    const gate = admitToTarget(health, "r", 1);
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, "target_disabled", kind);
    assert.equal(gate.waitMs, CIRCUIT.configurationCooldownMs - 1);
  }
});

test("rate limits and cancellations never trip the breaker; the ledger waits those out", () => {
  const health = initialHealth();
  for (let index = 0; index < 10; index += 1) {
    assert.equal(recordOutcome(health, K.RATE_LIMIT, index), null);
    assert.equal(recordOutcome(health, K.CANCELLED, index), null);
  }
  assert.equal(health.state, H.HEALTHY);
});

test("in the ledger: an open target is routed around, and one probe is admitted when it recovers", () => {
  const state = emptyLedgerState();
  for (let index = 0; index < CIRCUIT.openAfter; index += 1) {
    reserveCapacity(state, { requestId: `f${index}`, models: ["big"], estimatedTokens: 1 }, 0);
    releaseReservation(state, { requestId: `f${index}`, kind: K.SERVER_ERROR }, 0);
  }
  const routed = reserveCapacity(state, { requestId: "a", models: ["big", "small"], estimatedTokens: 1 }, 1);
  assert.deepEqual([routed.granted, routed.model], [true, "small"]);
  const waiting = reserveCapacity(state, { requestId: "b", models: ["big"], estimatedTokens: 1 }, 1);
  assert.deepEqual([waiting.granted, waiting.reason], [false, "target_open"]);

  const later = CIRCUIT.baseCooldownMs + 1;
  const probe = reserveCapacity(state, { requestId: "probe", models: ["big"], estimatedTokens: 1 }, later);
  assert.equal(probe.probe, true);
  const blocked = reserveCapacity(state, { requestId: "second", models: ["big"], estimatedTokens: 1 }, later);
  assert.deepEqual([blocked.granted, blocked.reason], [false, "target_probing"], "one probe at a time");
  const healed = releaseReservation(state, { requestId: "probe", kind: null }, later + 10);
  assert.deepEqual(healed.transition, { model: "big", from: H.PROBING, to: H.HEALTHY });
  assert.equal(reserveCapacity(state, { requestId: "second", models: ["big"], estimatedTokens: 1 }, later + 11).granted, true);
});

test("a probe abandoned without an outcome frees the probe slot", () => {
  const state = emptyLedgerState();
  for (let index = 0; index < CIRCUIT.openAfter; index += 1) {
    reserveCapacity(state, { requestId: `f${index}`, models: ["big"], estimatedTokens: 1 }, 0);
    releaseReservation(state, { requestId: `f${index}`, kind: K.TIMEOUT }, 0);
  }
  const at = CIRCUIT.baseCooldownMs + 1;
  reserveCapacity(state, { requestId: "probe", models: ["big"], estimatedTokens: 1 }, at);
  releaseReservation(state, { requestId: "probe" }, at);
  assert.equal(reserveCapacity(state, { requestId: "next", models: ["big"], estimatedTokens: 1 }, at + 1).probe, true);
});

test("the snapshot shows health but never a request id", () => {
  const state = emptyLedgerState();
  for (let index = 0; index < CIRCUIT.openAfter; index += 1) {
    reserveCapacity(state, { requestId: `f${index}`, models: ["big"], estimatedTokens: 1 }, 0);
    releaseReservation(state, { requestId: `f${index}`, kind: K.SERVER_ERROR }, 0);
  }
  reserveCapacity(state, { requestId: "probe-secret-id", models: ["big"], estimatedTokens: 1 }, CIRCUIT.baseCooldownMs + 1);
  const snapshot = ledgerSnapshot(state, CIRCUIT.baseCooldownMs + 2);
  assert.equal(snapshot.models.big.health.state, H.PROBING);
  assert.doesNotMatch(JSON.stringify(snapshot), /probe-secret-id/u);
});
