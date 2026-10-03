import { spawn, type ChildProcess } from "node:child_process";
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
        // Its own process group, so a timeout reaches what the command started
        // (npm -> node -> test workers), not just the command itself.
        detached: POSIX,
      });
      liveGroups.track(child.pid);
      // Each stream keeps its start and its end; a test run's summary is at the end.
      // Together they stay within the combined limit.
      const stderrKeep = Math.min(this.maxStderrBytes, Math.floor(this.maxCombinedOutputBytes / 2));
      const stdout = new HeadAndTail(Math.min(this.maxStdoutBytes, this.maxCombinedOutputBytes - stderrKeep));
      const stderr = new HeadAndTail(stderrKeep);
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let abandonTimer: NodeJS.Timeout | undefined;

      const stop = (): void => {
        killTree(child, "SIGTERM");
        forceKillTimer ??= setTimeout(() => killTree(child, "SIGKILL"), 250);
        forceKillTimer.unref();
        // A process that left the group (setsid) can hold the pipes open past
        // any kill; stop waiting for it rather than for the command.
        abandonTimer ??= setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(child.exitCode, child.signalCode);
        }, ABANDON_AFTER_MS);
        abandonTimer.unref();
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

      // Output past the limits is dropped from the middle, not a reason to
      // kill the command: its exit code still decides the outcome.
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const cleanUp = (): void => {
        clearTimeout(timer);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        if (abandonTimer !== undefined) clearTimeout(abandonTimer);
        request.signal?.removeEventListener("abort", abort);
        // Whatever the command left running in its group goes with it.
        killTree(child, "SIGKILL");
        liveGroups.release(child.pid);
      };
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        cleanUp();
        if (settled) return;
        settled = true;
        resolveResult({
          exitCode,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut,
          cancelled,
          truncated: stdout.omitted > 0 || stderr.omitted > 0,
          durationMs: Date.now() - startedAt,
        });
      };
      child.once("error", (error) => {
        cleanUp();
        if (!settled) {
          settled = true;
          reject(new SafeCommandError("spawn-failed", "Unable to start command.", { cause: error }));
        }
      });
      child.once("close", finish);
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

const POSIX = process.platform !== "win32";
/** How long to wait for the pipes after the kill before returning without them. */
const ABANDON_AFTER_MS = 2_000;

/**
 * Keeps the first and last `limit / 2` bytes of a stream and counts what was
 * dropped between them, so memory stays bounded however much a command prints.
 */
class HeadAndTail {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  public constructor(limit: number) {
    this.headLimit = Math.ceil(limit / 2);
    this.tailLimit = Math.floor(limit / 2);
  }

  public push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headLimit) {
      const taken = rest.subarray(0, this.headLimit - this.headBytes);
      this.head.push(taken);
      this.headBytes += taken.length;
      rest = rest.subarray(taken.length);
    }
    if (rest.length === 0 || this.tailLimit === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= this.tailLimit) {
      this.tailBytes -= this.tail.shift()!.length;
    }
  }

  public get omitted(): number {
    return this.total - this.headBytes - Math.min(this.tailBytes, this.tailLimit);
  }

  public text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const joined = Buffer.concat(this.tail);
    const tail = joined.subarray(Math.max(0, joined.length - this.tailLimit)).toString("utf8");
    return this.omitted === 0 ? head + tail : `${head}\n[... ${this.omitted} bytes of output omitted ...]\n${tail}`;
  }
}

/**
 * Signals the command's whole process group (POSIX) or process tree
 * (Windows, via taskkill /T). A group that is already gone is not an error.
 */
function killTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (POSIX) {
    try { process.kill(-pid, signal); return; } catch { /* no such group: fall back to the command itself */ }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (POSIX) {
    child.kill(signal);
    return;
  }
  const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  taskkill.once("error", () => child.kill(signal));
}

/**
 * Command groups started by this process. A group of its own no longer hears
 * the terminal's Ctrl-C, so while any is running, SIGINT/SIGTERM/SIGHUP to
 * Atlas are passed on to them before taking their usual effect.
 */
const liveGroups = new (class {
  private readonly pids = new Set<number>();
  private readonly forward = (signal: NodeJS.Signals): void => {
    for (const pid of this.pids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
    this.pids.clear();
    this.detach();
    process.kill(process.pid, signal);
  };
  private readonly onExit = (): void => {
    for (const pid of this.pids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
  };

  public track(pid: number | undefined): void {
    if (!POSIX || pid === undefined) return;
    if (this.pids.size === 0) this.attach();
    this.pids.add(pid);
  }

  public release(pid: number | undefined): void {
    if (pid === undefined || !this.pids.delete(pid) || this.pids.size > 0) return;
    this.detach();
  }

  private attach(): void {
    for (const signal of FORWARDED_SIGNALS) process.once(signal, this.forward);
    process.once("exit", this.onExit);
  }

  private detach(): void {
    for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, this.forward);
    process.removeListener("exit", this.onExit);
  }
})();
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

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
