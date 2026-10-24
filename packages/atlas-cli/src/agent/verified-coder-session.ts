import { compareValidationSnapshots } from "../domain/validation-comparator.js";
import type { ValidationComparison, ValidationSnapshot } from "../domain/validation-result.js";
import {
  decideVerificationAction,
  describeBaseline,
  describeNewFailures,
  type VerificationPlan,
} from "./verification-planning.js";
import {
  DEFAULT_REPAIR_LOOP_POLICY,
  decideRepair,
  failureFingerprint,
  type RepairDecision,
  type RepairRecord,
  type RepairStopReason,
} from "./repair-loop-policy.js";

export type ProposedEditOperation = "create" | "update" | "delete" | "rename";

export interface ProposedEdit {
  readonly path: string;
  readonly operation: ProposedEditOperation;
}

export interface AgentEvidence {
  readonly label: string;
  readonly content: string;
}

export interface AgentPassResult {
  readonly status: "completed" | "blocked" | "failed" | "cancelled" | "approval-required";
  readonly response: string;
  readonly message: string | null;
  /** Edits applied during this pass only; the session accumulates across passes. */
  readonly edits: readonly ProposedEdit[];
}

export type VerificationStatus =
  | "verified"
  | "regressed"
  | "inconclusive"
  | "unverified"
  | "not-applicable";

export interface VerificationReport {
  readonly status: VerificationStatus;
  /** Number of agent passes performed (1 = no repair was needed or attempted). */
  readonly attempts: number;
  readonly profileIds: readonly string[];
  readonly summary: ValidationComparison["summary"] | null;
  readonly newFailures: readonly string[];
  /** Plain-language explanation suitable for a pull request body. */
  readonly message: string;
  /** The pass at which repair moved to the escalation model, when it did. */
  readonly escalatedAtPass?: number;
  /**
   * Which repair-loop limit ended the loop with failures still present:
   * iteration-limit, time-limit, spend-limit or no-progress. Null when no
   * limit ended it (verified, inconclusive, unverified, not applicable).
   */
  readonly stopReason: RepairStopReason | null;
  /** The facts behind the last repair decision; present once a repair was considered. */
  readonly loop?: RepairLoopReport;
}

export interface RepairLoopReport {
  /** Repairs made in total, across the primary and escalation models. */
  readonly repairs: number;
  readonly elapsedMs: number;
  /** Model output tokens spent by the whole session at the decision, or null when unmetered. */
  readonly tokensSpent: number | null;
  /** How many repairs in the deciding tier targeted the failure that was still present. */
  readonly sameFailure: number;
  /** Normalised fingerprint of the failures the change introduced. */
  readonly fingerprint: string;
  readonly limits: {
    readonly maxRepairAttempts: number;
    readonly escalationAttempts: number | null;
    readonly maxWallMs: number | null;
    readonly maxTokens: number | null;
    readonly maxSameFailure: number;
  };
}

export interface RepairLoopLimits {
  /** No repair starts once this much wall time has passed since the session started; null = no limit. Default 6 hours. */
  readonly maxWallMs?: number | null;
  /** No repair starts once `tokensSpent()` reaches this; null = no limit. */
  readonly maxTokens?: number | null;
  /** No repair starts once the same failure has survived this many repairs by one model. Default 2. */
  readonly maxSameFailure?: number;
}

export interface VerifiedCoderResult {
  readonly status: AgentPassResult["status"];
  readonly response: string;
  readonly message: string | null;
  readonly edits: readonly ProposedEdit[];
  readonly verification: VerificationReport;
}

export interface VerifiedCoderSessionOptions {
  readonly plan: VerificationPlan;
  readonly runAgent: (evidence: readonly AgentEvidence[]) => Promise<AgentPassResult>;
  readonly runValidation: (label: ValidationSnapshot["label"]) => Promise<ValidationSnapshot>;
  readonly baseEvidence?: readonly AgentEvidence[];
  readonly maxRepairAttempts?: number;
  /**
   * A stronger agent for when the normal repair budget is spent and the
   * change still breaks checks. It continues from the same checkpoint (the
   * working tree with every edit so far, and only the failures the change
   * introduced as evidence); the task is never restarted, and it spends from
   * the same token budget.
   */
  readonly escalation?: {
    readonly attempts: number;
    readonly runAgent: (evidence: readonly AgentEvidence[]) => Promise<AgentPassResult>;
  };
  readonly compare?: (baseline: ValidationSnapshot, postChange: ValidationSnapshot) => ValidationComparison;
  /** Wall-time, spend and no-progress limits, checked before every repair. */
  readonly loopLimits?: RepairLoopLimits;
  /** Model output tokens the session has spent so far (the shared budget ledger), or null when unmetered. */
  readonly tokensSpent?: () => number | null;
  readonly now?: () => number;
}

const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;
const BASELINE_EVIDENCE_LABEL = "Repository checks before your change (measured)";
const REPAIR_EVIDENCE_LABEL = "Validation failures your previous edits introduced";

/**
 * Runs the coding agent and then holds it to account against the repository's
 * own checks.
 *
 * The sequence is: capture a pre-change baseline, let the agent edit, re-run
 * the same checks, and diff the two. Only failures the change actually
 * *introduced* trigger a repair pass, so an already-red repository neither
 * blocks the change nor gets silently "fixed" beyond the objective.
 *
 * Every dependency is injected, so the whole loop — including the repair
 * path — is testable without a model, a filesystem, or a subprocess.
 */
export class VerifiedCoderSession {
  readonly #plan: VerificationPlan;
  readonly #runAgent: VerifiedCoderSessionOptions["runAgent"];
  readonly #runValidation: VerifiedCoderSessionOptions["runValidation"];
  readonly #baseEvidence: readonly AgentEvidence[];
  readonly #maxRepairAttempts: number;
  readonly #compare: NonNullable<VerifiedCoderSessionOptions["compare"]>;
  readonly #escalation: VerifiedCoderSessionOptions["escalation"];
  readonly #maxWallMs: number | null;
  readonly #maxTokens: number | null;
  readonly #maxSameFailure: number;
  readonly #tokensSpent: () => number | null;
  readonly #now: () => number;

  public constructor(options: VerifiedCoderSessionOptions) {
    this.#plan = options.plan;
    this.#runAgent = options.runAgent;
    this.#runValidation = options.runValidation;
    this.#baseEvidence = options.baseEvidence ?? [];
    this.#maxRepairAttempts = options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
    this.#compare = options.compare ?? compareValidationSnapshots;
    this.#escalation = options.escalation;
    this.#maxWallMs = options.loopLimits?.maxWallMs === undefined ? DEFAULT_REPAIR_LOOP_POLICY.maxWallMs : options.loopLimits.maxWallMs;
    this.#maxTokens = options.loopLimits?.maxTokens ?? DEFAULT_REPAIR_LOOP_POLICY.maxTokens;
    this.#maxSameFailure = options.loopLimits?.maxSameFailure ?? DEFAULT_REPAIR_LOOP_POLICY.maxSameFailure;
    this.#tokensSpent = options.tokensSpent ?? (() => null);
    this.#now = options.now ?? Date.now;
    if (this.#maxWallMs !== null && (!Number.isSafeInteger(this.#maxWallMs) || this.#maxWallMs < 1)) {
      throw new RangeError("loopLimits.maxWallMs must be a positive integer or null.");
    }
    if (this.#maxTokens !== null && (!Number.isSafeInteger(this.#maxTokens) || this.#maxTokens < 1)) {
      throw new RangeError("loopLimits.maxTokens must be a positive integer or null.");
    }
    if (!Number.isSafeInteger(this.#maxSameFailure) || this.#maxSameFailure < 1 || this.#maxSameFailure > 10) {
      throw new RangeError("loopLimits.maxSameFailure must be an integer between 1 and 10.");
    }
    if (this.#escalation && (!Number.isSafeInteger(this.#escalation.attempts) || this.#escalation.attempts < 1 || this.#escalation.attempts > 5)) {
      throw new RangeError("escalation.attempts must be an integer between 1 and 5.");
    }
    if (!Number.isSafeInteger(this.#maxRepairAttempts) || this.#maxRepairAttempts < 0 || this.#maxRepairAttempts > 10) {
      throw new RangeError("maxRepairAttempts must be an integer between 0 and 10.");
    }
  }

  public async run(): Promise<VerifiedCoderResult> {
    // The baseline has to be captured before the agent touches anything;
    // afterwards there is no clean state left to compare against.
    let baseline: ValidationSnapshot | null = null;
    let unverifiableReason = this.#plan.skipReason;

    if (!this.#plan.skipped) {
      baseline = await this.#runValidation("baseline");
      if (isWhollyUnrunnable(baseline)) {
        // Every check failed to even start — almost always missing
        // dependencies in this environment. Comparing against this would
        // classify everything as inconclusive and burn the repair budget on
        // a problem the model cannot fix by editing code.
        baseline = null;
        unverifiableReason =
          "The repository's own checks could not be started in this environment (dependencies are likely not installed), so this change was not verified.";
      }
    }

    const accumulated = new Map<string, ProposedEditOperation>();
    let pass = 0;
    let last: AgentPassResult | null = null;
    let evidence: readonly AgentEvidence[] = baseline === null
      ? this.#baseEvidence
      : [...this.#baseEvidence, { label: BASELINE_EVIDENCE_LABEL, content: describeBaseline(baseline) }];
    let comparison: ValidationComparison | null = null;
    let escalatedAtPass: number | undefined;
    // Repairs made so far, oldest first, each with the failure it targeted.
    // The escalation model starts a fresh tier: its own attempt budget and
    // its own no-progress count, since a stronger model deserves its own try
    // at a failure the first model could not move.
    const repairs: RepairRecord[] = [];
    let tierStart = 0;
    let decision: RepairDecision | null = null;
    const startedAt = this.#now();

    for (;;) {
      pass += 1;
      last = await (escalatedAtPass !== undefined && this.#escalation ? this.#escalation.runAgent(evidence) : this.#runAgent(evidence));
      mergeEdits(accumulated, last.edits);

      if (last.status !== "completed") {
        // An agent that ran out of turns or hit a failure loop may still have
        // applied real edits. Those are checked against the same baseline so
        // the report says what the partial work does to the repository; it
        // never becomes "verified", because the objective was not finished.
        if ((last.status === "blocked" || last.status === "failed") && accumulated.size > 0 && baseline !== null) {
          try {
            const partial = this.#compare(baseline, await this.#runValidation("post-change"));
            const action = decideVerificationAction(partial, pass, Number.POSITIVE_INFINITY);
            const stopped = `The agent stopped with status '${last.status}' after changing ${accumulated.size} file(s), so the objective is not confirmed.`;
            const [status, detail]: [VerificationStatus, string] = action === "accept"
              ? ["unverified", "The repository's own checks reported no failures introduced by these edits; that is not a completion claim."]
              : action === "inconclusive"
                ? ["inconclusive", "The checks could not be compared reliably, so the effect of these edits is unknown."]
                : ["regressed", `The repository's own checks report ${partial.summary.new} failure(s) introduced by these edits.`];
            return this.#result(last, accumulated, this.#report(status, pass, partial, escalatedAtPass, null, undefined, `Partial work: ${stopped} ${detail}`));
          } catch {
            /* fall through to the plain report below: partial evidence is best effort */
          }
        }
        return this.#result(last, accumulated, {
          status: "not-applicable",
          attempts: pass,
          profileIds: [],
          summary: null,
          newFailures: [],
          message: `The agent stopped with status '${last.status}', so no verification was attempted.`,
          stopReason: null,
        });
      }

      if (accumulated.size === 0) {
        return this.#result(last, accumulated, {
          status: "not-applicable",
          attempts: pass,
          profileIds: [],
          summary: null,
          newFailures: [],
          message: "The agent proposed no file changes, so there was nothing to verify.",
          stopReason: null,
        });
      }

      if (baseline === null) {
        return this.#result(last, accumulated, {
          status: "unverified",
          attempts: pass,
          profileIds: this.#plan.profiles.map((profile) => profile.id),
          summary: null,
          newFailures: [],
          message: unverifiableReason ?? "This change was not verified.",
          stopReason: null,
        });
      }

      const postChange = await this.#runValidation("post-change");
      comparison = this.#compare(baseline, postChange);
      // The loop policy, not the attempt counter, decides whether to repair.
      const action = decideVerificationAction(comparison, pass, Number.POSITIVE_INFINITY);
      const loop = (current: RepairDecision | null) => (current === null ? undefined : this.#loopReport(current, repairs.length));

      if (action === "accept") {
        return this.#result(last, accumulated, this.#report("verified", pass, comparison, escalatedAtPass, null, loop(decision),
          `Verified: the repository's own checks (${this.#plan.profiles.map((profile) => profile.id).join(", ")}) reported no failures that this change introduced${escalatedAtPass === undefined ? "" : ` (repaired by the escalation model from pass ${escalatedAtPass})`}.`));
      }
      if (action === "inconclusive") {
        return this.#result(last, accumulated, this.#report("inconclusive", pass, comparison, escalatedAtPass, null, loop(decision),
          "Inconclusive: checks could not be compared reliably (an infrastructure failure or a flaky result), so this change is unverified and needs a human look."));
      }

      // The change introduced failures. Checked before every repair: the
      // attempt budget, wall time, token spend, and whether the same failure
      // keeps surviving repairs.
      const fingerprint = failureFingerprint(newFailureLines(comparison));
      decision = this.#decide(repairs.slice(tierStart), startedAt, fingerprint, escalatedAtPass !== undefined);
      if (!decision.proceed && (decision.reason === "iteration-limit" || decision.reason === "no-progress") && this.#escalation && escalatedAtPass === undefined) {
        // The normal model is out of attempts or not making progress and the
        // change still breaks checks: a stronger model continues from this
        // checkpoint instead of giving up. Escalation happens once.
        escalatedAtPass = pass + 1;
        tierStart = repairs.length;
        decision = this.#decide(repairs.slice(tierStart), startedAt, fingerprint, true);
      }

      if (!decision.proceed) {
        return this.#result(last, accumulated, this.#report("regressed", pass, comparison, escalatedAtPass, decision.reason, loop(decision),
          `Regressed: this change introduced ${comparison.summary.new} validation failure(s) that survived ${pass - 1} repair attempt(s)${escalatedAtPass === undefined ? "" : `, including ${pass - escalatedAtPass + 1} by the escalation model`}. ${decision.message} (${decision.reason}).`));
      }

      // Repair: hand the model only what it broke, and go round again.
      repairs.push({ fingerprint });
      const failureText = describeNewFailures(comparison);
      evidence = [...this.#baseEvidence, { label: REPAIR_EVIDENCE_LABEL, content: failureText }];
    }
  }

  #decide(tierRepairs: readonly RepairRecord[], startedAt: number, fingerprint: string, escalated: boolean): RepairDecision {
    return decideRepair({
      policy: {
        maxRepairs: escalated && this.#escalation ? this.#escalation.attempts : this.#maxRepairAttempts,
        maxWallMs: this.#maxWallMs,
        maxTokens: this.#maxTokens,
        maxSameFailure: this.#maxSameFailure,
      },
      repairs: tierRepairs,
      startedAt,
      now: this.#now(),
      tokensSpent: this.#tokensSpent(),
      fingerprint,
    });
  }

  #loopReport(decision: RepairDecision, totalRepairs: number): RepairLoopReport {
    return {
      repairs: totalRepairs,
      elapsedMs: decision.elapsedMs,
      tokensSpent: decision.tokensSpent,
      sameFailure: decision.sameFailure,
      fingerprint: decision.fingerprint,
      limits: {
        maxRepairAttempts: this.#maxRepairAttempts,
        escalationAttempts: this.#escalation?.attempts ?? null,
        maxWallMs: this.#maxWallMs,
        maxTokens: this.#maxTokens,
        maxSameFailure: this.#maxSameFailure,
      },
    };
  }

  #report(
    status: VerificationStatus,
    attempts: number,
    comparison: ValidationComparison,
    escalatedAtPass: number | undefined,
    stopReason: RepairStopReason | null,
    loop: RepairLoopReport | undefined,
    message: string,
  ): VerificationReport {
    return {
      ...(escalatedAtPass === undefined ? {} : { escalatedAtPass }),
      status,
      attempts,
      profileIds: this.#plan.profiles.map((profile) => profile.id),
      summary: comparison.summary,
      newFailures: newFailureLines(comparison),
      message,
      stopReason,
      ...(loop === undefined ? {} : { loop }),
    };
  }

  #result(
    pass: AgentPassResult,
    accumulated: ReadonlyMap<string, ProposedEditOperation>,
    verification: VerificationReport,
  ): VerifiedCoderResult {
    return {
      status: pass.status,
      response: pass.response,
      message: pass.message,
      edits: [...accumulated].map(([path, operation]) => ({ path, operation })).sort((left, right) => left.path.localeCompare(right.path)),
      verification,
    };
  }
}

/**
 * A file created in one pass and then amended in a repair pass is still a
 * creation from the pull request's point of view, so "create" is sticky.
 */
function mergeEdits(accumulated: Map<string, ProposedEditOperation>, edits: readonly ProposedEdit[]): void {
  for (const edit of edits) {
    const existing = accumulated.get(edit.path);
    accumulated.set(edit.path, existing === "create" ? "create" : edit.operation);
  }
}

function newFailureLines(comparison: ValidationComparison): string[] {
  return comparison.diagnostics
    .filter((item) => item.classification === "new")
    .map((item) => `[${item.kind}] ${item.caseId}: ${item.diagnostic.message}`);
}

function isWhollyUnrunnable(snapshot: ValidationSnapshot): boolean {
  return (
    snapshot.observations.length > 0 &&
    snapshot.observations.every((observation) => observation.outcome === "execution-failed")
  );
}
