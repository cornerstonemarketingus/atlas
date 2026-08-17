import { createHash } from "node:crypto";
import type {
  ClassifiedValidationDiagnostic,
  ValidationComparison,
  ValidationDiagnostic,
  ValidationObservation,
  ValidationSnapshot,
} from "./validation-result.js";

export interface ValidationComparisonLimits {
  readonly maxObservationsPerSnapshot: number;
  readonly maxDiagnosticsPerObservation: number;
  readonly maxTextLength: number;
}

const DEFAULT_LIMITS: ValidationComparisonLimits = {
  maxObservationsPerSnapshot: 1_000,
  maxDiagnosticsPerObservation: 10_000,
  maxTextLength: 16_384,
};

export class InvalidValidationSnapshotError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidValidationSnapshotError";
  }
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().replaceAll("\\", "/").replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function fingerprintValidationDiagnostic(
  observation: Pick<ValidationObservation, "caseId" | "kind">,
  diagnostic: ValidationDiagnostic,
): string {
  const identity = [
    observation.kind,
    normalize(observation.caseId),
    diagnostic.severity,
    normalize(diagnostic.code),
    normalize(diagnostic.path),
    diagnostic.line ?? "",
    diagnostic.column ?? "",
    normalize(diagnostic.message),
  ].join("\u001f");
  return `vd-${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

interface DiagnosticState {
  readonly fingerprint: string;
  readonly caseId: string;
  readonly kind: ValidationObservation["kind"];
  readonly diagnostic: ValidationDiagnostic;
  readonly attemptsPresent: Set<number>;
}

interface SnapshotState {
  readonly diagnostics: Map<string, DiagnosticState>;
  readonly attemptsByCase: Map<string, Set<number>>;
  readonly infrastructureCases: Set<string>;
  readonly infrastructureFailures: number;
}

function validateText(value: string, field: string, limits: ValidationComparisonLimits): void {
  if (value.trim().length === 0 || value.length > limits.maxTextLength) {
    throw new InvalidValidationSnapshotError(`${field} must contain 1-${limits.maxTextLength} characters.`);
  }
}

function analyze(snapshot: ValidationSnapshot, limits: ValidationComparisonLimits): SnapshotState {
  if (snapshot.observations.length > limits.maxObservationsPerSnapshot) {
    throw new InvalidValidationSnapshotError(`Snapshot exceeds ${limits.maxObservationsPerSnapshot} observations.`);
  }
  const diagnostics = new Map<string, DiagnosticState>();
  const attemptsByCase = new Map<string, Set<number>>();
  const infrastructureCases = new Set<string>();
  let infrastructureFailures = 0;

  for (const observation of snapshot.observations) {
    validateText(observation.caseId, "caseId", limits);
    validateText(observation.command.executable, "command.executable", limits);
    validateText(observation.command.workingDirectory, "command.workingDirectory", limits);
    if (!Number.isFinite(observation.command.elapsedMilliseconds) || observation.command.elapsedMilliseconds < 0) {
      throw new InvalidValidationSnapshotError("command.elapsedMilliseconds must be finite and non-negative.");
    }
    if (!Number.isSafeInteger(observation.command.argumentCount) || observation.command.argumentCount < 0) {
      throw new InvalidValidationSnapshotError("command.argumentCount must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(observation.attempt) || observation.attempt < 1) {
      throw new InvalidValidationSnapshotError("attempt must be a positive safe integer.");
    }
    if (observation.diagnostics.length > limits.maxDiagnosticsPerObservation) {
      throw new InvalidValidationSnapshotError(`Observation exceeds ${limits.maxDiagnosticsPerObservation} diagnostics.`);
    }
    const key = `${observation.kind}\u001f${normalize(observation.caseId)}`;
    const attempts = attemptsByCase.get(key) ?? new Set<number>();
    if (attempts.has(observation.attempt)) {
      throw new InvalidValidationSnapshotError(`Duplicate attempt ${observation.attempt} for '${observation.caseId}'.`);
    }
    attempts.add(observation.attempt);
    attemptsByCase.set(key, attempts);
    if (observation.outcome === "execution-failed" || observation.outcome === "cancelled") {
      infrastructureFailures += 1;
      infrastructureCases.add(key);
    }
    for (const diagnostic of observation.diagnostics) {
      validateText(diagnostic.message, "diagnostic.message", limits);
      const fingerprint = fingerprintValidationDiagnostic(observation, diagnostic);
      const existing = diagnostics.get(fingerprint);
      if (existing !== undefined) {
        existing.attemptsPresent.add(observation.attempt);
      } else {
        diagnostics.set(fingerprint, {
          fingerprint,
          caseId: observation.caseId,
          kind: observation.kind,
          diagnostic: { ...diagnostic },
          attemptsPresent: new Set([observation.attempt]),
        });
      }
    }
  }
  return { diagnostics, attemptsByCase, infrastructureCases, infrastructureFailures };
}

function isConclusive(state: SnapshotState, diagnostic: DiagnosticState | undefined, representative: DiagnosticState): boolean {
  const key = `${representative.kind}\u001f${normalize(representative.caseId)}`;
  const attempts = state.attemptsByCase.get(key);
  if (attempts === undefined || state.infrastructureCases.has(key)) return false;
  return diagnostic === undefined || diagnostic.attemptsPresent.size === attempts.size;
}

export function compareValidationSnapshots(
  baseline: ValidationSnapshot,
  postChange: ValidationSnapshot,
  limits: ValidationComparisonLimits = DEFAULT_LIMITS,
): ValidationComparison {
  if (baseline.label !== "baseline" || postChange.label !== "post-change") {
    throw new InvalidValidationSnapshotError("Snapshots must be supplied in baseline then post-change order.");
  }
  const before = analyze(baseline, limits);
  const after = analyze(postChange, limits);
  const fingerprints = [...new Set([...before.diagnostics.keys(), ...after.diagnostics.keys()])].sort();
  const diagnostics: ClassifiedValidationDiagnostic[] = fingerprints.map((fingerprint) => {
    const oldDiagnostic = before.diagnostics.get(fingerprint);
    const newDiagnostic = after.diagnostics.get(fingerprint);
    const representative = newDiagnostic ?? oldDiagnostic;
    if (representative === undefined) throw new Error("Unreachable missing diagnostic.");
    let classification: ClassifiedValidationDiagnostic["classification"];
    if (!isConclusive(before, oldDiagnostic, representative) || !isConclusive(after, newDiagnostic, representative)) {
      classification = "flaky-or-inconclusive";
    } else if (oldDiagnostic !== undefined && newDiagnostic !== undefined) {
      classification = "persistent";
    } else if (oldDiagnostic !== undefined) {
      classification = "fixed";
    } else {
      classification = "new";
    }
    return { fingerprint, classification, caseId: representative.caseId, kind: representative.kind, diagnostic: representative.diagnostic };
  });
  const count = (classification: ClassifiedValidationDiagnostic["classification"]): number =>
    diagnostics.filter((item) => item.classification === classification).length;
  const summary = {
    fixed: count("fixed"),
    new: count("new"),
    persistent: count("persistent"),
    flakyOrInconclusive: count("flaky-or-inconclusive"),
    baselineInfrastructureFailures: before.infrastructureFailures,
    postChangeInfrastructureFailures: after.infrastructureFailures,
  };
  const exitRecommendation = summary.postChangeInfrastructureFailures > 0 || summary.flakyOrInconclusive > 0
    ? "rerun"
    : summary.new > 0
      ? "reject"
      : "accept";
  return { diagnostics, summary, exitRecommendation };
}
