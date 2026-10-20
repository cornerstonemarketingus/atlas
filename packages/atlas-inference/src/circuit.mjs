import { InferenceErrorKind as K, recoveryFor } from "./errors.mjs";

/**
 * Per-target health, so Atlas stops sending to a target that keeps failing
 * and finds out on its own when it recovers (docs/PROGRAM.md Phase 1.3).
 *
 *   HEALTHY ──2 transient failures──▶ DEGRADED ──4──▶ OPEN (cooldown)
 *      ▲                                  │               │ cooldown over
 *      └──────── success ◀────────────────┘            PROBING: one request
 *                                                          │ fails: OPEN, cooldown doubles
 *
 * Rate limits are not failures here: the quota ledger already waits them out
 * from the provider's own reset times. Configuration failures (bad key, no
 * permission, no credit, model gone) open the circuit at once for a long
 * time: retrying cannot fix them, so every retry is waste.
 */

export const TargetHealth = Object.freeze({ HEALTHY: "HEALTHY", DEGRADED: "DEGRADED", OPEN: "OPEN", PROBING: "PROBING" });

export const CIRCUIT = Object.freeze({
  degradeAfter: 2,
  openAfter: 4,
  baseCooldownMs: 30_000,
  maxCooldownMs: 600_000,
  configurationCooldownMs: 3_600_000,
});

const COUNTED = new Set([K.SERVER_ERROR, K.TIMEOUT, K.NETWORK, K.CAPACITY, K.EMPTY_MODEL_RESPONSE, K.INVALID_RESPONSE, K.UNKNOWN]);

export function initialHealth() {
  return { state: TargetHealth.HEALTHY, consecutiveFailures: 0, openUntil: null, cooldownMs: CIRCUIT.baseCooldownMs, probeRequestId: null, lastKind: null };
}

/** The state as of `now`: an OPEN circuit whose cooldown is over is PROBING. Does not mutate. */
export function effectiveHealth(health, now) {
  const current = health ?? initialHealth();
  if (current.state === TargetHealth.OPEN && current.openUntil !== null && current.openUntil <= now) return { ...current, state: TargetHealth.PROBING };
  return current;
}

/**
 * Whether `requestId` may be sent to the target now. PROBING admits exactly
 * one request at a time, the probe; everyone else waits for its outcome.
 * @returns {{ allowed: true, probe?: true } | { allowed: false, waitMs: number, reason: string }}
 */
export function admit(health, requestId, now) {
  const current = effectiveHealth(health, now);
  if (current.state === TargetHealth.OPEN) return { allowed: false, waitMs: current.openUntil - now, reason: current.lastKind && !recoveryFor(current.lastKind).retrySameTarget ? "target_disabled" : "target_open" };
  if (current.state === TargetHealth.PROBING) {
    if (current.probeRequestId && current.probeRequestId !== requestId) return { allowed: false, waitMs: 1_000, reason: "target_probing" };
    return { allowed: true, probe: true };
  }
  return { allowed: true };
}

/** Marks the request that is probing a recovering target. Mutates and returns `health`. */
export function claimProbe(health, requestId, now) {
  const next = effectiveHealth(health, now);
  Object.assign(health, next, { probeRequestId: requestId });
  return health;
}

/**
 * Records one outcome and returns the transition, if any, so the caller can
 * emit inference.provider_degraded / inference.provider_recovered.
 * `kind` is null for success. Mutates `health`.
 * @returns {{ from: string, to: string } | null}
 */
export function recordOutcome(health, kind, now) {
  const before = effectiveHealth(health, now).state;
  Object.assign(health, effectiveHealth(health, now));
  health.probeRequestId = null;
  if (kind === null || kind === undefined) {
    Object.assign(health, initialHealth());
    return before === TargetHealth.HEALTHY ? null : { from: before, to: TargetHealth.HEALTHY };
  }
  health.lastKind = kind;
  const recovery = recoveryFor(kind);
  if (recovery.disableTarget) {
    health.state = TargetHealth.OPEN;
    health.openUntil = now + CIRCUIT.configurationCooldownMs;
    return before === TargetHealth.OPEN ? null : { from: before, to: TargetHealth.OPEN };
  }
  if (!COUNTED.has(kind)) return null;
  if (before === TargetHealth.PROBING) {
    health.cooldownMs = Math.min(health.cooldownMs * 2, CIRCUIT.maxCooldownMs);
    health.state = TargetHealth.OPEN;
    health.openUntil = now + health.cooldownMs;
    return { from: before, to: TargetHealth.OPEN };
  }
  health.consecutiveFailures += 1;
  if (health.consecutiveFailures >= CIRCUIT.openAfter) {
    health.state = TargetHealth.OPEN;
    health.openUntil = now + health.cooldownMs;
  } else if (health.consecutiveFailures >= CIRCUIT.degradeAfter) {
    health.state = TargetHealth.DEGRADED;
  }
  return health.state === before ? null : { from: before, to: health.state };
}
