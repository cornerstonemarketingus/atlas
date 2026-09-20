import { spawn } from "node:child_process";

/**
 * Bounded command execution for tools.
 *
 * No shell, ever: arguments are passed as an array so a repository path or a
 * model-supplied string cannot become shell syntax. Output is capped, the
 * process is killed on timeout or cancellation, and the environment is
 * allow-listed rather than inherited so a tool cannot read a credential that
 * happens to be exported in the daemon's environment.
 */
const SAFE_ENVIRONMENT_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "COMSPEC", "PATHEXT", "USERPROFILE"];

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export function safeEnvironment(extra = {}) {
  const base = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) base[key] = process.env[key];
  }
  // Caller-supplied values cannot override the allow-listed ones — PATH in
  // particular, where a replacement redirects every command that follows.
  return { ...extra, ...base };
}

export function runCommand(command, args, { cwd, timeoutMs = 60_000, signal, maxBytes = 1_000_000, env = {}, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      // Secrets are written to stdin rather than passed as arguments, where
      // they would be visible in the process table to every user on the box.
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
      env: safeEnvironment(env),
      // Its own process group, so a timeout can kill everything the command
      // started. Killing only the direct child left grandchildren running and
      // holding the inherited stdio open, which meant a 300ms timeout could
      // take 30 seconds and leave an orphan behind.
      detached: process.platform !== "win32",
    });
    if (input !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;

    const killTree = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => { timedOut = true; killTree("SIGKILL"); }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killTree("SIGTERM");
      // A child that ignores SIGTERM used to leave this promise unsettled
      // forever. Escalate rather than wait.
      setTimeout(() => killTree("SIGKILL"), 2_000).unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(0, maxBytes); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(0, maxBytes); });
    const settle = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    child.on("error", (error) => settle({ ok: false, code: "SPAWN_FAILED", stdout, stderr: error.message }));
    // `exit`, not `close`: close waits for every inherited pipe, which a
    // backgrounded grandchild holds open indefinitely.
    child.on("exit", (status) => settle({
      ok: status === 0 && !timedOut && !cancelled,
      status,
      timedOut,
      cancelled,
      stdout,
      stderr,
    }));
  });
}

/** Runs a Git command in a repository, failing with a readable message. */
export async function git(repository, args, options = {}) {
  const result = await runCommand("git", ["-C", repository, ...args], options);
  if (result.timedOut) throw new CommandError("TOOL_TIMEOUT", `git ${args[0]} timed out.`);
  if (!result.ok) throw new CommandError("GIT_FAILED", `git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  return result.stdout;
}
