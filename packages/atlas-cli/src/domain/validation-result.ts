export const VALIDATION_KINDS = [
  "format", "lint", "typecheck", "test", "build", "security", "custom",
] as const;

export type ValidationKind = (typeof VALIDATION_KINDS)[number];
export type ValidationOutcome = "passed" | "failed" | "execution-failed" | "cancelled";
export type DiagnosticSeverity = "error" | "warning" | "info";

/** Sanitized process metadata. Environment values and raw command strings are deliberately excluded. */
export interface ValidationCommandMetadata {
  readonly executable: string;
  readonly argumentCount: number;
  readonly workingDirectory: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly elapsedMilliseconds: number;
}

export interface ValidationDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface ValidationObservation {
  readonly caseId: string;
  readonly kind: ValidationKind;
  readonly attempt: number;
  readonly outcome: ValidationOutcome;
  readonly command: ValidationCommandMetadata;
  readonly diagnostics: readonly ValidationDiagnostic[];
}

export interface ValidationSnapshot {
  readonly label: "baseline" | "post-change";
  readonly observations: readonly ValidationObservation[];
}

export type ValidationChangeClassification = "fixed" | "new" | "persistent" | "flaky-or-inconclusive";

export interface ClassifiedValidationDiagnostic {
  readonly fingerprint: string;
  readonly classification: ValidationChangeClassification;
  readonly caseId: string;
  readonly kind: ValidationKind;
  readonly diagnostic: ValidationDiagnostic;
}

export interface ValidationComparisonSummary {
  readonly fixed: number;
  readonly new: number;
  readonly persistent: number;
  readonly flakyOrInconclusive: number;
  readonly baselineInfrastructureFailures: number;
  readonly postChangeInfrastructureFailures: number;
}

export type ValidationExitRecommendation = "accept" | "reject" | "rerun";

export interface ValidationComparison {
  readonly diagnostics: readonly ClassifiedValidationDiagnostic[];
  readonly summary: ValidationComparisonSummary;
  readonly exitRecommendation: ValidationExitRecommendation;
}
