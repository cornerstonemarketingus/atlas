export interface SafeCommandRequest {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface SafeCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface SafeCommandRunner {
  run(request: SafeCommandRequest): Promise<SafeCommandResult>;
}

export type SafeCommandErrorCode =
  | "invalid-request"
  | "executable-not-allowed"
  | "cwd-outside-repository"
  | "cwd-is-symlink"
  | "environment-not-allowed"
  | "spawn-failed";

export class SafeCommandError extends Error {
  public constructor(
    public readonly code: SafeCommandErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SafeCommandError";
  }
}
