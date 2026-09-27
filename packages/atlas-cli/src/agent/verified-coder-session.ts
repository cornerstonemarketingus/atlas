import { compareValidationSnapshots } from "../domain/validation-comparator.js";
import type { ValidationComparison, ValidationSnapshot } from "../domain/validation-result.js";
import {
  decideVerificationAction,
  describeNewFailures,
  type VerificationPlan,
} from "./verification-planning.js";

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
}

const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;
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

  public constructor(options: VerifiedCoderSessionOptions) {
    this.#plan = options.plan;
    this.#runAgent = options.runAgent;
    this.#runValidation = options.runValidation;
    this.#baseEvidence = options.baseEvidence ?? [];
    this.#maxRepairAttempts = options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
    this.#compare = options.compare ?? compareValidationSnapshots;
    this.#escalation = options.escalation;
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
    let evidence: readonly AgentEvidence[] = this.#baseEvidence;
    let comparison: ValidationComparison | null = null;
    let passBudget = this.#maxRepairAttempts + 1;
    let escalatedAtPass: number | undefined;

    for (;;) {
      pass += 1;
      last = await (escalatedAtPass !== undefined && this.#escalation ? this.#escalation.runAgent(evidence) : this.#runAgent(evidence));
      mergeEdits(accumulated, last.edits);

      if (last.status !== "completed") {
        return this.#result(last, accumulated, {
          status: "not-applicable",
          attempts: pass,
          profileIds: [],
          summary: null,
          newFailures: [],
          message: `The agent stopped with status '${last.status}', so no verification was attempted.`,
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
        });
      }

      const postChange = await this.#runValidation("post-change");
      comparison = this.#compare(baseline, postChange);
      let action = decideVerificationAction(comparison, pass, passBudget);
      if (action === "regressed" && this.#escalation && escalatedAtPass === undefined) {
        // The repair budget is spent and the change still breaks checks: a
        // stronger model continues from this checkpoint instead of giving up.
        escalatedAtPass = pass + 1;
        passBudget += this.#escalation.attempts;
        action = "repair";
      }

      if (action === "accept") {
        return this.#result(last, accumulated, this.#report("verified", pass, comparison, escalatedAtPass,
          `Verified: the repository's own checks (${this.#plan.profiles.map((profile) => profile.id).join(", ")}) reported no failures that this change introduced${escalatedAtPass === undefined ? "" : ` (repaired by the escalation model from pass ${escalatedAtPass})`}.`));
      }
      if (action === "inconclusive") {
        return this.#result(last, accumulated, this.#report("inconclusive", pass, comparison, escalatedAtPass,
          "Inconclusive: checks could not be compared reliably (an infrastructure failure or a flaky result), so this change is unverified and needs a human look."));
      }
      if (action === "regressed") {
        return this.#result(last, accumulated, this.#report("regressed", pass, comparison, escalatedAtPass,
          `Regressed: this change introduced ${comparison.summary.new} validation failure(s) that survived ${pass - 1} repair attempt(s)${escalatedAtPass === undefined ? "" : `, including ${pass - escalatedAtPass + 1} by the escalation model`}.`));
      }

      // Repair: hand the model only what it broke, and go round again.
      const failureText = describeNewFailures(comparison);
      evidence = [...this.#baseEvidence, { label: REPAIR_EVIDENCE_LABEL, content: failureText }];
    }
  }

  #report(
    status: VerificationStatus,
    attempts: number,
    comparison: ValidationComparison,
    escalatedAtPass: number | undefined,
    message: string,
  ): VerificationReport {
    return {
      ...(escalatedAtPass === undefined ? {} : { escalatedAtPass }),
      status,
      attempts,
      profileIds: this.#plan.profiles.map((profile) => profile.id),
      summary: comparison.summary,
      newFailures: comparison.diagnostics
        .filter((item) => item.classification === "new")
        .map((item) => `[${item.kind}] ${item.caseId}: ${item.diagnostic.message}`),
      message,
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

function isWhollyUnrunnable(snapshot: ValidationSnapshot): boolean {
  return (
    snapshot.observations.length > 0 &&
    snapshot.observations.every((observation) => observation.outcome === "execution-failed")
  );
}
