import { createHash } from "node:crypto";

/**
 * Limits for the verified coder's repair loop: how many repairs, how long,
 * how many model output tokens, and how many times the same failure may
 * survive a repair before the loop stops instead of paying to fix it again.
 * Checked before each repair starts, so a limit is never crossed by starting
 * one more attempt.
 *
 * Same semantics as the Genesis loop policy
 * (apps/local-control/src/platform/loop-policy.mjs). It is deliberately a
 * copy, not an import: packages do not reach into each other's sources.
 */
export interface RepairLoopPolicy {
  /** Repairs allowed in the current tier (the primary model, or the escalation model). */
  readonly maxRepairs: number;
  /** No repair starts once this much wall time has passed since the session started; null = no limit. */
  readonly maxWallMs: number | null;
  /** No repair starts once this many model output tokens are spent; null = no limit. */
  readonly maxTokens: number | null;
  /** No repair starts once the same failure has survived this many repairs. */
  readonly maxSameFailure: number;
}

export const DEFAULT_REPAIR_LOOP_POLICY: Omit<RepairLoopPolicy, "maxRepairs"> = Object.freeze({
  maxWallMs: 6 * 60 * 60_000,
  maxTokens: null,
  maxSameFailure: 2,
});

export const REPAIR_STOP_REASONS = ["iteration-limit", "time-limit", "spend-limit", "no-progress"] as const;
export type RepairStopReason = (typeof REPAIR_STOP_REASONS)[number];

/** A repair already made: the fingerprint of the failure it was asked to fix. */
export interface RepairRecord {
  readonly fingerprint: string;
}

export interface RepairLoopFacts {
  /** Repairs already made in the tier being decided. */
  readonly repairs: number;
  readonly elapsedMs: number;
  /** Output tokens spent so far, or null when unmetered. */
  readonly tokensSpent: number | null;
  /** How many of those repairs targeted the current failure. */
  readonly sameFailure: number;
  readonly fingerprint: string;
}

export type RepairDecision =
  | ({ readonly proceed: true } & RepairLoopFacts)
  | ({ readonly proceed: false; readonly reason: RepairStopReason; readonly message: string } & RepairLoopFacts);

/**
 * A stable identity for "the same failure": the newly introduced failures
 * with run-specific noise (ANSI colour, absolute paths, hashes, numbers such
 * as timings, line/column numbers and ports, whitespace, case) removed, in a
 * stable order.
 */
export function failureFingerprint(failures: readonly string[]): string {
  const normalised = failures.map(normaliseFailure).sort().join("\n");
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

function normaliseFailure(text: string): string {
  return text
    .slice(-1500)
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@-]+)+[\\/]([\w.@-]+)/gu, "$1")
    .replace(/\b[0-9a-f]{7,64}\b/giu, "#")
    .replace(/\d+(?:\.\d+)?/gu, "#")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Whether another repair may start. `repairs` are the repairs already made
 * in the current tier, oldest first. Rules are checked in a fixed order —
 * attempts, time, spend, progress — so the reported reason is deterministic.
 */
export function decideRepair(input: {
  readonly policy: RepairLoopPolicy;
  readonly repairs: readonly RepairRecord[];
  readonly startedAt: number;
  readonly now: number;
  readonly tokensSpent: number | null;
  readonly fingerprint: string;
}): RepairDecision {
  const { policy, repairs, fingerprint } = input;
  const elapsedMs = Math.max(0, input.now - input.startedAt);
  const tokensSpent = input.tokensSpent !== null && Number.isFinite(input.tokensSpent) ? input.tokensSpent : null;
  const sameFailure = repairs.filter((repair) => repair.fingerprint === fingerprint).length;
  const facts: RepairLoopFacts = { repairs: repairs.length, elapsedMs, tokensSpent, sameFailure, fingerprint };
  const stop = (reason: RepairStopReason, message: string): RepairDecision => ({ proceed: false, reason, message, ...facts });

  if (repairs.length >= policy.maxRepairs) {
    return stop("iteration-limit", `Still failing after ${repairs.length} repair attempt(s)`);
  }
  if (policy.maxWallMs !== null && elapsedMs >= policy.maxWallMs) {
    return stop("time-limit", `Stopped after ${Math.round(elapsedMs / 1000)} second(s), the time limit for repairs`);
  }
  if (policy.maxTokens !== null && tokensSpent !== null && tokensSpent >= policy.maxTokens) {
    return stop("spend-limit", `Stopped after ${tokensSpent} model output tokens, the spending limit for repairs`);
  }
  if (sameFailure >= policy.maxSameFailure) {
    return stop("no-progress", `Stopped: the same failure survived ${sameFailure} repair attempt(s), so another attempt is unlikely to help`);
  }
  return { proceed: true, ...facts };
}
