import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { newId } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { confineRealPath } from "../../agent/tools/path-confinement.mjs";
import { DEFAULT_ALLOWED_EXECUTABLES, TerminalPolicyError, evaluateCommand } from "./command-policy.mjs";
import { createRedactor, hostSecretValues } from "./redaction.mjs";

/**
 * TerminalController — the execution plane's terminal worker (blueprint §6).
 *
 * Gives an agent a scratch workspace per (tenant, task) and runs commands in
 * it, streaming output back, under a command policy.
 *
 * What it does
 * ------------
 * - Workspaces are directories directly under one configured root, created
 *   0700, named from sanitized tenant/task ids plus randomness. Destroying one
 *   re-checks through realpath that the target is still a direct child of the
 *   root, so a workspace swapped for a symlink cannot turn `destroy` into
 *   `rm -rf` somewhere else.
 * - Commands are spawned from an argv array with `shell: false`. There is no
 *   shell anywhere on the path, so no string the model writes is ever parsed
 *   as shell syntax. The executable must be a bare allowlisted name and is
 *   resolved against a minimal PATH owned by the controller.
 * - The policy (command-policy.mjs) refuses privilege changers, shells,
 *   container and process-control tools, network tools unless enabled,
 *   publishing and global-config commands, and any argument path — absolute
 *   or `..` — that resolves outside the workspace through symlinks.
 * - The child environment is built from nothing: PATH, HOME=workspace,
 *   TMPDIR=workspace/.tmp, LANG, a few git/npm hardening variables, plus
 *   caller-supplied keys that are on an allowlist. Nothing from the daemon's
 *   environment is inherited, so an exported API key is not visible to it.
 * - Limits: wall-clock timeout (SIGTERM to the process group, then SIGKILL
 *   after a grace period), a byte cap per output stream, and a cap on
 *   concurrent commands per workspace. On Linux, when `prlimit` exists and
 *   works, the child is additionally started under RLIMIT_CPU, RLIMIT_AS,
 *   RLIMIT_FSIZE, RLIMIT_NOFILE (and RLIMIT_NPROC when configured).
 * - Output is redacted (credential patterns plus the exact values of
 *   secret-named daemon variables) before it is streamed or returned.
 * - Commands the policy classifies `high` (git commit, npm install, npx,
 *   network-enabled, ...) are not run unless the approval callback returns
 *   exactly `true` for that exact argv.
 * - Every result carries an `isolation` record of what was actually applied,
 *   so callers never have to assume.
 *
 * Threat model and what is NOT isolated
 * -------------------------------------
 * The adversary is the agent's own choices: a confused or prompt-injected
 * model issuing a destructive or exfiltrating command. The controller makes
 * such commands hard to issue by accident and easy to audit. It is
 * process-level sandboxing only; it is NOT a container or a VM:
 *
 * - The child runs as the daemon's user with that user's filesystem access.
 *   `node` and `python3` are allowlisted, and arbitrary code in them can read
 *   or write anything the user can; argv path checks do not see inside code.
 * - There is no network isolation. `network: false` only blocks dedicated
 *   network tools and marks the command's risk; an interpreter can still open
 *   sockets.
 * - There is no PID, mount, IPC or user namespace; the child can see other
 *   processes. RLIMIT_NPROC is per-user and ignored for root.
 * - Path checks are check-then-use; a racing process could swap a symlink.
 * - Redaction is pattern-based; an encoded secret passes through.
 *
 * Real isolation for untrusted workloads requires running this controller
 * inside a container or microVM (rootless, no host mounts beyond the
 * workspace root, egress-filtered network, seccomp) — the hosted execution
 * plane must do that and treat this layer as defence in depth.
 */
export class TerminalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TerminalError";
    this.code = code;
  }
}

/** Caller-supplied environment keys that may reach the child. */
export const DEFAULT_ALLOWED_ENV_KEYS = Object.freeze(["NODE_ENV", "CI", "NO_COLOR", "FORCE_COLOR", "TZ", "LC_ALL", "DEBUG", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE"]);

const DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  maxTimeoutMs: 30 * 60_000,
  killGraceMs: 2_000,
  maxOutputBytes: 1_000_000,
  maxConcurrentPerWorkspace: 4,
  maxStdinBytes: 1_000_000,
  rlimits: Object.freeze({
    cpuSeconds: 120,
    // V8 reserves a large virtual address range up front; 4 GiB leaves room
    // for it while still stopping a runaway allocation from eating the host.
    addressSpaceBytes: 4 * 1024 ** 3,
    fileSizeBytes: 256 * 1024 ** 2,
    openFiles: 1024,
    processes: undefined,
  }),
});

const ID_SEGMENT = /[^A-Za-z0-9_-]+/g;

export class TerminalController {
  #root;
  #allowedExecutables;
  #allowedEnvKeys;
  #approve;
  #options;
  #pathDirectories;
  #redact;
  #prlimit;
  #workspaces = new Map();
  #commands = new Map();

  /**
   * @param {object} options
   * @param {string} options.rootDirectory  directory every workspace lives directly under
   * @param {string[]} [options.allowedExecutables]
   * @param {string[]} [options.allowedEnvKeys]
   * @param {(request: {argv: string[], workspaceId: string, risk: string, reasons: string[], network: boolean}) => boolean|Promise<boolean>} [options.approve]
   * @param {string[]} [options.pathDirectories]  the child's PATH; defaults to node's own bin dir plus system bins
   * @param {string[]} [options.knownSecrets]  exact values to scrub from output (secret-named daemon env values are added)
   * @param {boolean|string} [options.prlimit]  false disables; a path overrides detection
   */
  constructor({
    rootDirectory,
    allowedExecutables = DEFAULT_ALLOWED_EXECUTABLES,
    allowedEnvKeys = DEFAULT_ALLOWED_ENV_KEYS,
    approve = undefined,
    pathDirectories = undefined,
    knownSecrets = [],
    prlimit = undefined,
    timeoutMs = DEFAULTS.timeoutMs,
    maxTimeoutMs = DEFAULTS.maxTimeoutMs,
    killGraceMs = DEFAULTS.killGraceMs,
    maxOutputBytes = DEFAULTS.maxOutputBytes,
    maxConcurrentPerWorkspace = DEFAULTS.maxConcurrentPerWorkspace,
    rlimits = {},
  } = {}) {
    if (typeof rootDirectory !== "string" || rootDirectory.length === 0) {
      throw new TerminalError("NO_ROOT", "TerminalController needs a rootDirectory for workspaces.");
    }
    mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(resolve(rootDirectory));
    if (this.#root === sep) throw new TerminalError("UNSAFE_ROOT", "The filesystem root cannot be the workspace root.");
    this.#allowedExecutables = [...allowedExecutables];
    this.#allowedEnvKeys = new Set(allowedEnvKeys);
    this.#approve = approve;
    this.#pathDirectories = pathDirectories ?? [...new Set([dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"])];
    this.#redact = createRedactor({ knownSecrets: [...knownSecrets, ...hostSecretValues()] });
    this.#options = {
      timeoutMs, maxTimeoutMs, killGraceMs, maxOutputBytes, maxConcurrentPerWorkspace,
      rlimits: { ...DEFAULTS.rlimits, ...rlimits },
    };
    this.#prlimit = detectPrlimit(prlimit);
  }

  get rootDirectory() {
    return this.#root;
  }

  /** What process-level isolation this host can apply, independent of any command. */
  capabilities() {
    return {
      noShell: true,
      processGroup: process.platform !== "win32",
      rlimits: this.#prlimit ? { tool: "prlimit", path: this.#prlimit } : { tool: null, reason: prlimitUnavailableReason() },
      container: false,
      networkIsolation: false,
    };
  }

  createWorkspace({ tenantId, taskId, template = undefined } = {}) {
    for (const [label, value] of [["tenantId", tenantId], ["taskId", taskId]]) {
      if (typeof value !== "string" || value.length === 0 || value.length > 200) {
        throw new TerminalError("INVALID_INPUT", `${label} must be a non-empty string of at most 200 characters.`);
      }
    }
    const name = `${segment(tenantId)}--${segment(taskId)}--${randomBytes(6).toString("hex")}`;
    const directory = join(this.#root, name);
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(directory, ".tmp"), { mode: 0o700 });

    const id = newId("workerSession");
    const workspace = { id, tenantId, taskId, directory, createdAt: new Date().toISOString(), running: new Set() };
    this.#workspaces.set(id, workspace);
    try {
      if (template !== undefined) this.#applyTemplate(workspace, template);
    } catch (error) {
      this.#workspaces.delete(id);
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return describe(workspace);
  }

  getWorkspace(workspaceId) {
    return describe(this.#workspace(workspaceId));
  }

  listWorkspaces() {
    return [...this.#workspaces.values()].map(describe);
  }

  /**
   * Removes a workspace directory. Refuses unless its real path is a direct
   * child of the real workspace root — a workspace directory replaced by a
   * symlink, or a record that points elsewhere, is never followed.
   */
  async destroyWorkspace(workspaceId) {
    const workspace = this.#workspace(workspaceId);
    await Promise.all([...workspace.running].map((commandId) => this.#terminate(commandId, "cancelled")));

    let stat;
    try { stat = lstatSync(workspace.directory); } catch { stat = null; }
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new TerminalError("WORKSPACE_OUTSIDE_ROOT", "The workspace directory is no longer a plain directory; refusing to remove it.");
      }
      const real = realpathSync(workspace.directory);
      if (dirname(real) !== this.#root || real === this.#root) {
        throw new TerminalError("WORKSPACE_OUTSIDE_ROOT", "The workspace resolves outside the workspace root; refusing to remove it.");
      }
      rmSync(real, { recursive: true, force: true });
    }
    this.#workspaces.delete(workspaceId);
    return { workspaceId, destroyed: true };
  }

  /**
   * Starts a command. Resolves to either
   *   `{ status: "requires_approval", risk, reasons, argv }` — nothing ran; or
   *   `{ status: "running", id, events, result }` where `events` is an async
   *   iterator of `{ stream, chunk }` and `result` settles with the outcome.
   * Throws TerminalPolicyError / TerminalError when the command is refused.
   */
  async runCommand(workspaceId, { argv, cwd = ".", timeoutMs = undefined, env = {}, stdin = undefined, network = false } = {}) {
    const workspace = this.#workspace(workspaceId);
    const workspaceRoot = realpathSync(workspace.directory);
    const cwdReal = confineRealPath(workspaceRoot, typeof cwd === "string" ? cwd : ".", (code, message) => {
      return new TerminalPolicyError(code === "PATH_ESCAPES_ROOT" ? "CWD_OUTSIDE_WORKSPACE" : code, message);
    });
    if (!isDirectory(cwdReal)) throw new TerminalError("CWD_NOT_FOUND", `cwd '${cwd}' is not a directory in the workspace.`);

    const decision = evaluateCommand({
      argv, workspaceRoot, cwd: cwdReal, network: network === true, allowedExecutables: this.#allowedExecutables,
    });
    const childEnv = this.#childEnvironment(workspaceRoot, env);
    const timeout = this.#timeout(timeoutMs);
    if (stdin !== undefined && (typeof stdin !== "string" || Buffer.byteLength(stdin) > DEFAULTS.maxStdinBytes)) {
      throw new TerminalError("INVALID_INPUT", "stdin must be a string of at most 1 MB.");
    }

    if (decision.risk === "high") {
      const approved = this.#approve
        ? await this.#approve({ argv: [...argv], workspaceId, risk: decision.risk, reasons: decision.reasons, network: network === true })
        : false;
      if (approved !== true) {
        return { status: "requires_approval", workspaceId, argv: [...argv], risk: decision.risk, reasons: decision.reasons };
      }
    }

    // Checked after the approval await so two racing calls cannot both pass.
    if (workspace.running.size >= this.#options.maxConcurrentPerWorkspace) {
      throw new TerminalError("CONCURRENCY_LIMIT", `This workspace already has ${workspace.running.size} running commands.`);
    }

    const executablePath = this.#resolveExecutable(decision.executable);
    return this.#spawn(workspace, { argv, executablePath, cwd: cwdReal, env: childEnv, timeout, stdin, decision, network: network === true });
  }

  /** Cancels a running command by killing its whole process group. */
  async cancel(commandId) {
    if (!this.#commands.has(commandId)) return { commandId, cancelled: false };
    await this.#terminate(commandId, "cancelled");
    return { commandId, cancelled: true };
  }

  // -------------------------------------------------------------------------

  #workspace(workspaceId) {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) throw new TerminalError("WORKSPACE_NOT_FOUND", `No workspace '${String(workspaceId).slice(0, 80)}'.`);
    return workspace;
  }

  #applyTemplate(workspace, template) {
    if (!template || typeof template !== "object" || Array.isArray(template)) {
      throw new TerminalError("INVALID_TEMPLATE", "A template must be an object like { files: { 'path': 'content' } }.");
    }
    const files = template.files ?? {};
    for (const [relativePath, content] of Object.entries(files)) {
      if (typeof content !== "string") throw new TerminalError("INVALID_TEMPLATE", `Template file '${relativePath}' must have string content.`);
      const target = confineRealPath(workspace.directory, relativePath, (code, message) => new TerminalError("INVALID_TEMPLATE", message));
      if (target === realpathSync(workspace.directory)) throw new TerminalError("INVALID_TEMPLATE", "A template file needs a file name.");
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { mode: 0o600, flag: "wx" });
    }
  }

  #childEnvironment(workspaceRoot, extra) {
    if (extra === null || typeof extra !== "object" || Array.isArray(extra)) {
      throw new TerminalError("INVALID_INPUT", "env must be an object of string values.");
    }
    const environment = {
      PATH: this.#pathDirectories.join(delimiter),
      HOME: workspaceRoot,
      TMPDIR: join(workspaceRoot, ".tmp"),
      LANG: "C.UTF-8",
      // Keep git and npm from reading host-level configuration or prompting.
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
    };
    for (const [key, value] of Object.entries(extra)) {
      if (!this.#allowedEnvKeys.has(key)) throw new TerminalError("ENV_KEY_NOT_ALLOWED", `Environment variable '${key}' is not on the allowlist.`);
      if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) {
        throw new TerminalError("INVALID_INPUT", `Environment variable '${key}' must be a string under 4 KiB.`);
      }
      environment[key] = value;
    }
    return environment;
  }

  #timeout(requested) {
    if (requested === undefined) return this.#options.timeoutMs;
    if (!Number.isInteger(requested) || requested < 1 || requested > this.#options.maxTimeoutMs) {
      throw new TerminalError("INVALID_INPUT", `timeoutMs must be an integer between 1 and ${this.#options.maxTimeoutMs}.`);
    }
    return requested;
  }

  #resolveExecutable(name) {
    for (const directory of this.#pathDirectories) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        if (isFile(candidate)) return candidate;
      } catch {
        // Not in this directory.
      }
    }
    throw new TerminalError("EXECUTABLE_NOT_FOUND", `'${name}' is allowlisted but not installed on this host.`);
  }

  #rlimitArgs() {
    const limits = this.#options.rlimits;
    const args = [];
    const applied = {};
    const add = (flag, key, value) => {
      if (Number.isInteger(value) && value > 0) { args.push(`--${flag}=${value}`); applied[key] = value; }
    };
    add("cpu", "cpuSeconds", limits.cpuSeconds);
    add("as", "addressSpaceBytes", limits.addressSpaceBytes);
    add("fsize", "fileSizeBytes", limits.fileSizeBytes);
    add("nofile", "openFiles", limits.openFiles);
    add("nproc", "processes", limits.processes);
    return { args, applied };
  }

  #spawn(workspace, { argv, executablePath, cwd, env, timeout, stdin, decision, network }) {
    const id = newId("toolCall");
    const useGroups = process.platform !== "win32";
    const rlimits = this.#prlimit ? this.#rlimitArgs() : null;
    // prlimit sets the limits on itself and then execs the command, so the pid
    // (and process group) is the command's own.
    const [file, args] = rlimits && rlimits.args.length > 0
      ? [this.#prlimit, [...rlimits.args, "--", executablePath, ...argv.slice(1)]]
      : [executablePath, argv.slice(1)];

    const isolation = {
      level: "process",
      container: false,
      noShell: true,
      envScrubbed: true,
      cwdConfined: true,
      argumentPathPolicy: true,
      processGroup: useGroups,
      timeoutMs: timeout,
      maxOutputBytes: this.#options.maxOutputBytes,
      rlimits: rlimits && rlimits.args.length > 0
        ? { applied: true, tool: "prlimit", ...rlimits.applied }
        : { applied: false, reason: this.#prlimit ? "no limits configured" : prlimitUnavailableReason() },
      network: network ? "enabled (not isolated)" : "not isolated (network tools refused by policy only)",
      filesystem: "host user permissions (workspace confinement is argv-level only)",
    };

    const started = Date.now();
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      detached: useGroups,
      windowsHide: true,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const queue = createEventQueue();
    const record = {
      id, child, workspace, state: "running", timedOut: false, cancelled: false, killTimer: null,
      done: null,
    };
    this.#commands.set(id, record);
    workspace.running.add(id);

    const streams = {
      stdout: { chunks: [], bytes: 0, truncated: false },
      stderr: { chunks: [], bytes: 0, truncated: false },
    };
    const maxBytes = this.#options.maxOutputBytes;
    const collect = (name) => (chunk) => {
      const stream = streams[name];
      if (stream.truncated) return;
      let piece = chunk;
      if (stream.bytes + piece.length > maxBytes) {
        piece = piece.subarray(0, maxBytes - stream.bytes);
        stream.truncated = true;
      }
      stream.bytes += piece.length;
      stream.chunks.push(piece);
      if (piece.length > 0) queue.push({ stream: name, chunk: this.#redact(piece.toString("utf8")).text });
      if (stream.truncated) queue.push({ stream: name, chunk: truncationMarker(maxBytes) });
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    if (stdin !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }

    const timer = setTimeout(() => {
      record.timedOut = true;
      this.#terminate(id, "timeout");
    }, timeout);

    const result = new Promise((resolveResult) => {
      let spawnError = null;
      child.on("error", (error) => { spawnError = error; });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (record.killTimer) clearTimeout(record.killTimer);
        record.state = "exited";
        workspace.running.delete(id);
        this.#commands.delete(id);
        const finish = (name) => {
          const { text, count } = this.#redact(Buffer.concat(streams[name].chunks).toString("utf8"));
          return { text: streams[name].truncated ? `${text}${truncationMarker(maxBytes)}` : text, count };
        };
        const stdout = finish("stdout");
        const stderr = finish("stderr");
        queue.end();
        resolveResult({
          commandId: id,
          workspaceId: workspace.id,
          argv: [...argv],
          risk: decision.risk,
          exitCode: spawnError ? null : exitCode,
          signal: signal ?? null,
          timedOut: record.timedOut,
          cancelled: record.cancelled,
          spawnError: spawnError ? spawnError.code ?? spawnError.message : null,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: { stdout: streams.stdout.truncated, stderr: streams.stderr.truncated },
          redactions: stdout.count + stderr.count,
          durationMs: Date.now() - started,
          isolation,
        });
      });
    });
    record.done = result;

    return { status: "running", id, workspaceId: workspace.id, risk: decision.risk, events: queue.iterator, result };
  }

  /** SIGTERM to the process group, SIGKILL after the grace period; resolves when the command has exited. */
  async #terminate(commandId, reason) {
    const record = this.#commands.get(commandId);
    if (!record) return;
    if (record.state === "running") {
      record.state = "terminating";
      if (reason === "cancelled") record.cancelled = true;
      signalGroup(record.child, "SIGTERM");
      record.killTimer = setTimeout(() => signalGroup(record.child, "SIGKILL"), this.#options.killGraceMs);
    }
    await record.done;
  }
}

// ---------------------------------------------------------------------------

function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

function createEventQueue() {
  const buffered = [];
  const waiting = [];
  let ended = false;
  const iterator = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (buffered.length > 0) return Promise.resolve({ value: buffered.shift(), done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolveNext) => waiting.push(resolveNext));
    },
    return() {
      ended = true;
      buffered.length = 0;
      while (waiting.length > 0) waiting.shift()({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  return {
    iterator,
    push(event) {
      if (ended) return;
      if (waiting.length > 0) waiting.shift()({ value: event, done: false });
      else buffered.push(event);
    },
    end() {
      ended = true;
      while (waiting.length > 0) waiting.shift()({ value: undefined, done: true });
    },
  };
}

function truncationMarker(maxBytes) {
  return `\n[atlas: output truncated after ${maxBytes} bytes]\n`;
}

function segment(value) {
  return value.replace(ID_SEGMENT, "_").slice(0, 48) || "_";
}

function describe(workspace) {
  return {
    id: workspace.id,
    tenantId: workspace.tenantId,
    taskId: workspace.taskId,
    directory: workspace.directory,
    createdAt: workspace.createdAt,
    runningCommands: workspace.running.size,
  };
}

function isDirectory(path) {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function isFile(path) {
  try { return realpathSync(path) && !lstatSync(realpathSync(path)).isDirectory(); } catch { return false; }
}

/**
 * Finds a working `prlimit` (util-linux). It is only trusted after it has
 * actually started a trivial command under a limit, so a binary that exists
 * but cannot run here is reported as unavailable rather than claimed.
 */
function detectPrlimit(option) {
  if (option === false || process.platform !== "linux") return null;
  const candidates = typeof option === "string" ? [option] : ["/usr/bin/prlimit", "/bin/prlimit", "/usr/local/bin/prlimit"];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const probe = spawnSync(candidate, ["--cpu=5", "--", process.execPath, "-e", ""], { env: {}, timeout: 10_000, stdio: "ignore" });
      if (probe.status === 0 && basename(candidate) === "prlimit") return candidate;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

function prlimitUnavailableReason() {
  return process.platform === "linux" ? "prlimit not found or not usable on this host" : `resource limits are not implemented on ${process.platform}`;
}
