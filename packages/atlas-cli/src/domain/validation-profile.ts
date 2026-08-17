import type { ValidationKind, ValidationSnapshot } from "./validation-result.js";
import type { SafeCommandRunner } from "./safe-command-runner.js";

/**
 * An explicit, reviewable validation command. Atlas never discovers or runs
 * package scripts from repository content without a caller supplying one.
 */
export interface ValidationCommandProfile {
  readonly id: string;
  readonly kind: ValidationKind;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly attempts?: number;
}

export interface ValidationProfileRunRequest {
  readonly label: ValidationSnapshot["label"];
  readonly profiles: readonly ValidationCommandProfile[];
  readonly signal?: AbortSignal;
}

export interface ValidationProfileRunner {
  run(request: ValidationProfileRunRequest): Promise<ValidationSnapshot>;
}

/** Dependency boundary: supplied runners retain all executable/cwd/env policy enforcement. */
export interface ValidationCommandExecutor extends Pick<SafeCommandRunner, "run"> {}

export class InvalidValidationProfileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidValidationProfileError";
  }
}
