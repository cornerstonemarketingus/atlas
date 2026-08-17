import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  SafeCommandRequest,
  SafeCommandResult,
  SafeCommandRunner,
} from "../domain/safe-command-runner.js";
import { SafeCommandError } from "../domain/safe-command-runner.js";

export interface BoundedCommandRunnerOptions {
  readonly repositoryRoot: string;
  readonly allowedExecutables: readonly string[];
  readonly allowedEnvironmentVariables?: readonly string[];
  readonly inheritedEnvironmentVariables?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxCombinedOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_BYTES = 1_048_576;
const DEFAULT_COMBINED_BYTES = 2_097_152;

export class BoundedCommandRunner implements SafeCommandRunner {
  private readonly rootPromise: Promise<string>;
  private readonly allowedExecutables: ReadonlySet<string>;
  private readonly allowedEnvironmentVariables: ReadonlySet<string>;
  private readonly inheritedEnvironmentVariables: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly maxCombinedOutputBytes: number;

  public constructor(options: BoundedCommandRunnerOptions) {
    if (options.allowedExecutables.length === 0) {
      throw new SafeCommandError("invalid-request", "At least one executable must be allowed.");
    }
    this.rootPromise = realpath(resolve(options.repositoryRoot));
    this.allowedExecutables = new Set(options.allowedExecutables.map(normalizeExecutable));
    this.allowedEnvironmentVariables = new Set(
      (options.allowedEnvironmentVariables ?? []).map(normalizeEnvironmentName),
    );
    this.inheritedEnvironmentVariables = options.inheritedEnvironmentVariables ?? [];
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxStdoutBytes = positiveInteger(
      options.maxStdoutBytes ?? DEFAULT_STREAM_BYTES,
      "maxStdoutBytes",
    );
    this.maxStderrBytes = positiveInteger(
      options.maxStderrBytes ?? DEFAULT_STREAM_BYTES,
      "maxStderrBytes",
    );
    this.maxCombinedOutputBytes = positiveInteger(
      options.maxCombinedOutputBytes ?? DEFAULT_COMBINED_BYTES,
      "maxCombinedOutputBytes",
    );
  }

  public async run(request: SafeCommandRequest): Promise<SafeCommandResult> {
    if (!this.allowedExecutables.has(normalizeExecutable(request.executable))) {
      throw new SafeCommandError(
        "executable-not-allowed",
        `Executable is not allowlisted: ${request.executable}`,
      );
    }
    if (request.signal?.aborted === true) {
      return emptyCancelledResult();
    }

    const root = await this.rootPromise;
    const cwd = await resolveWorkingDirectory(root, request.cwd);
    const environment = this.createEnvironment(request.environment);
    const startedAt = Date.now();

    return await new Promise<SafeCommandResult>((resolveResult, reject) => {
      const child = spawn(request.executable, [...(request.args ?? [])], {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let combinedBytes = 0;
      let timedOut = false;
      let cancelled = false;
      let truncated = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const stop = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        forceKillTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 250);
        forceKillTimer.unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, this.timeoutMs);
      timer.unref();
      const abort = (): void => {
        cancelled = true;
        stop();
      };
      request.signal?.addEventListener("abort", abort, { once: true });

      const capture = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
        const streamLimit = stream === "stdout" ? this.maxStdoutBytes : this.maxStderrBytes;
        const current = stream === "stdout" ? stdout : stderr;
        const remaining = Math.max(
          0,
          Math.min(streamLimit - current.length, this.maxCombinedOutputBytes - combinedBytes),
        );
        const accepted = chunk.subarray(0, remaining);
        if (stream === "stdout") stdout = Buffer.concat([stdout, accepted]);
        else stderr = Buffer.concat([stderr, accepted]);
        combinedBytes += accepted.length;
        if (accepted.length < chunk.length) {
          truncated = true;
          stop();
        }
      };
      child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
      child.once("error", (error) => {
        clearTimeout(timer);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        request.signal?.removeEventListener("abort", abort);
        if (!settled) {
          settled = true;
          reject(new SafeCommandError("spawn-failed", "Unable to start command.", { cause: error }));
        }
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        request.signal?.removeEventListener("abort", abort);
        if (!settled) {
          settled = true;
          resolveResult({
            exitCode,
            signal,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            timedOut,
            cancelled,
            truncated,
            durationMs: Date.now() - startedAt,
          });
        }
      });
    });
  }

  private createEnvironment(requested?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of this.inheritedEnvironmentVariables) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    for (const [name, value] of Object.entries(requested ?? {})) {
      if (!this.allowedEnvironmentVariables.has(normalizeEnvironmentName(name))) {
        throw new SafeCommandError(
          "environment-not-allowed",
          `Environment variable is not allowlisted: ${name}`,
        );
      }
      environment[name] = value;
    }
    return environment;
  }
}

async function resolveWorkingDirectory(root: string, requested?: string): Promise<string> {
  if (requested !== undefined && isAbsolute(requested)) {
    throw new SafeCommandError("cwd-outside-repository", "Working directory must be relative.");
  }
  const segments = (requested ?? ".").split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
  if (segments.includes("..")) {
    throw new SafeCommandError("cwd-outside-repository", "Working directory traversal is not allowed.");
  }
  let candidate = root;
  for (const segment of segments) {
    candidate = resolve(candidate, segment);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new SafeCommandError("cwd-is-symlink", "Symbolic-link working directories are not allowed.");
    }
  }
  const canonical = await realpath(candidate);
  const fromRoot = relative(root, canonical);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new SafeCommandError("cwd-outside-repository", "Working directory is outside the repository.");
  }
  return canonical;
}

function normalizeExecutable(executable: string): string {
  return process.platform === "win32" ? executable.toLocaleLowerCase("en-US") : executable;
}

function normalizeEnvironmentName(name: string): string {
  return process.platform === "win32" ? name.toLocaleUpperCase("en-US") : name;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SafeCommandError("invalid-request", `${name} must be a positive integer.`);
  }
  return value;
}

function emptyCancelledResult(): SafeCommandResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    cancelled: true,
    truncated: false,
    durationMs: 0,
  };
}
