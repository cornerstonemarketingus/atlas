import type { SafeCommandResult } from "../domain/safe-command-runner.js";
import type {
  DiagnosticSeverity,
  ValidationDiagnostic,
  ValidationObservation,
  ValidationSnapshot,
} from "../domain/validation-result.js";
import {
  InvalidValidationProfileError,
  type ValidationCommandExecutor,
  type ValidationCommandProfile,
  type ValidationProfileRunRequest,
  type ValidationProfileRunner,
} from "../domain/validation-profile.js";

export interface ValidationProfileRunnerOptions {
  readonly maxProfiles?: number;
  readonly maxAttemptsPerProfile?: number;
  readonly maxOutputCharacters?: number;
}

const DEFAULT_MAX_PROFILES = 100;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 4_096;

/** Converts explicit commands into sanitized validation observations. */
export class SafeValidationProfileRunner implements ValidationProfileRunner {
  private readonly maxProfiles: number;
  private readonly maxAttempts: number;
  private readonly maxOutputCharacters: number;

  public constructor(
    private readonly commandRunner: ValidationCommandExecutor,
    options: ValidationProfileRunnerOptions = {},
  ) {
    this.maxProfiles = positiveInteger(options.maxProfiles ?? DEFAULT_MAX_PROFILES, "maxProfiles");
    this.maxAttempts = positiveInteger(options.maxAttemptsPerProfile ?? DEFAULT_MAX_ATTEMPTS, "maxAttemptsPerProfile");
    this.maxOutputCharacters = positiveInteger(
      options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS,
      "maxOutputCharacters",
    );
  }

  public async run(request: ValidationProfileRunRequest): Promise<ValidationSnapshot> {
    validateRequest(request, this.maxProfiles, this.maxAttempts);
    const observations: ValidationObservation[] = [];
    for (const profile of request.profiles) {
      const attempts = profile.attempts ?? 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        observations.push(await this.runAttempt(profile, attempt, request.signal));
        if (request.signal?.aborted === true) break;
      }
      if (request.signal?.aborted === true) break;
    }
    return { label: request.label, observations };
  }

  private async runAttempt(
    profile: ValidationCommandProfile,
    attempt: number,
    signal: AbortSignal | undefined,
  ): Promise<ValidationObservation> {
    try {
      const result = await this.commandRunner.run({
        executable: profile.executable,
        args: profile.args,
        ...(profile.cwd === undefined ? {} : { cwd: profile.cwd }),
        ...(profile.environment === undefined ? {} : { environment: profile.environment }),
        ...(signal === undefined ? {} : { signal }),
      });
      return toObservation(profile, attempt, result, this.maxOutputCharacters);
    } catch {
      return {
        caseId: profile.id,
        kind: profile.kind,
        attempt,
        outcome: "execution-failed",
        command: {
          executable: profile.executable,
          argumentCount: profile.args.length,
          workingDirectory: profile.cwd ?? ".",
          elapsedMilliseconds: 0,
        },
        diagnostics: [{ severity: "error", code: "command-execution-failed", message: "Validation command could not be started." }],
      };
    }
  }
}

function toObservation(
  profile: ValidationCommandProfile,
  attempt: number,
  result: SafeCommandResult,
  maxOutputCharacters: number,
): ValidationObservation {
  const base = {
    caseId: profile.id,
    kind: profile.kind,
    attempt,
    command: {
      executable: profile.executable,
      argumentCount: profile.args.length,
      workingDirectory: profile.cwd ?? ".",
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      ...(result.signal === null ? {} : { signal: result.signal }),
      elapsedMilliseconds: result.durationMs,
    },
  } as const;
  if (result.cancelled) return { ...base, outcome: "cancelled", diagnostics: [diagnostic("command-cancelled", "Validation command was cancelled.")] };
  if (result.timedOut) return { ...base, outcome: "execution-failed", diagnostics: [diagnostic("command-timed-out", "Validation command timed out.")] };
  if (result.truncated) return { ...base, outcome: "execution-failed", diagnostics: [diagnostic("command-output-truncated", "Validation command output was truncated.")] };
  if (result.exitCode === 0) return { ...base, outcome: "passed", diagnostics: [] };
  const output = boundedSanitizedOutput(result, maxOutputCharacters);
  const diagnostics: ValidationDiagnostic[] = [diagnostic("command-exit-nonzero", `Validation command exited with code ${result.exitCode ?? "unknown"}.`)];
  if (output.length > 0) diagnostics.push(diagnostic("command-output", output, "warning"));
  return { ...base, outcome: "failed", diagnostics };
}

function diagnostic(code: string, message: string, severity: DiagnosticSeverity = "error"): ValidationDiagnostic {
  return { severity, code, message };
}

function boundedSanitizedOutput(result: SafeCommandResult, maxCharacters: number): string {
  const combined = [result.stderr, result.stdout].filter((value) => value.length > 0).join("\n");
  const redacted = combined
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*([=:])\s*[^\s]+/giu, "$1$2[REDACTED]");
  return redacted.length <= maxCharacters ? redacted : `${redacted.slice(0, maxCharacters)}…`;
}

function validateRequest(request: ValidationProfileRunRequest, maxProfiles: number, maxAttempts: number): void {
  if (request.label !== "baseline" && request.label !== "post-change") {
    throw new InvalidValidationProfileError("label must be 'baseline' or 'post-change'.");
  }
  if (request.profiles.length === 0 || request.profiles.length > maxProfiles) {
    throw new InvalidValidationProfileError(`profiles must contain 1-${maxProfiles} entries.`);
  }
  const ids = new Set<string>();
  for (const profile of request.profiles) {
    if (profile.id.trim().length === 0 || profile.id.length > 200 || ids.has(profile.id)) {
      throw new InvalidValidationProfileError("Each profile requires a unique non-empty id.");
    }
    ids.add(profile.id);
    if (profile.executable.trim().length === 0 || profile.executable.length > 1_024) {
      throw new InvalidValidationProfileError(`Profile '${profile.id}' requires an executable.`);
    }
    if (!Array.isArray(profile.args) || profile.args.some((arg) => arg.length > 16_384)) {
      throw new InvalidValidationProfileError(`Profile '${profile.id}' has invalid arguments.`);
    }
    const attempts = profile.attempts ?? 1;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > maxAttempts) {
      throw new InvalidValidationProfileError(`Profile '${profile.id}' attempts must be 1-${maxAttempts}.`);
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new InvalidValidationProfileError(`${name} must be a positive integer.`);
  return value;
}
