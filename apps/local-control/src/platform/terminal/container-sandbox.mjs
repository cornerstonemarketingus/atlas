import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/**
 * Container isolation for the terminal controller (issue #72).
 *
 * The process runner confines what a command may *name*; it cannot stop an
 * interpreter from reading the operator's files or opening a socket. With a
 * sandbox configured, every command instead runs in a fresh, disposable
 * container:
 *
 * - Only the workspace is mounted, read-write, at /workspace. Nothing else
 *   from the host is visible: not the home directory, not the daemon's data,
 *   not other workspaces.
 * - The network is off (`--network none`) unless the command was explicitly
 *   network-enabled, which the policy already classes as high risk and
 *   routes through approval.
 * - All capabilities are dropped, privilege escalation is refused, the root
 *   filesystem is read-only apart from a small /tmp, and the process runs as
 *   the operator's uid/gid (not root) so files it writes stay theirs.
 * - CPU, memory and process-count limits are enforced by the kernel through
 *   the runtime, and the container is removed when the command ends.
 * - The environment is only what the controller built (never the daemon's),
 *   with HOME and TMPDIR pointed inside the mount.
 *
 * Arguments go to the runtime as an argv array with no shell. The image
 * decides which executables exist; the controller's command policy still
 * runs first, so refused commands never reach the runtime at all.
 *
 * What this does not do: it is not a VM. Kernel exploits and runtime bugs are
 * out of scope, and a network-enabled command has ordinary egress.
 */

export class ContainerSandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContainerSandboxError";
    this.code = code;
  }
}

export const CONTAINER_WORKDIR = "/workspace";

const DEFAULT_SANDBOX = Object.freeze({
  image: "node:22-bookworm-slim",
  cpus: 2,
  memoryBytes: 2 * 1024 ** 3,
  pidsLimit: 256,
  tmpfsBytes: 64 * 1024 ** 2,
});

// Registry references only: letters, digits and . _ - / : @ (for digests).
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/u;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

/** Keys the controller sets itself inside the container; never taken from the host. */
const CONTAINER_OWNED_KEYS = new Set(["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]);

/**
 * Normalizes the `container` option. Returns null when no sandbox was asked
 * for. When one was asked for and cannot work, it throws: a caller who asked
 * for isolation must never silently get the unisolated runner instead.
 */
export function resolveContainerSandbox(option, { probe = probeRuntime } = {}) {
  if (option === undefined || option === null || option === false) return null;
  if (typeof option !== "object" || Array.isArray(option)) {
    throw new ContainerSandboxError("INVALID_SANDBOX", "container must be an object such as { runtime: '/usr/bin/docker' }.");
  }
  const runtime = option.runtime;
  if (typeof runtime !== "string" || !isAbsolute(runtime)) {
    throw new ContainerSandboxError("INVALID_SANDBOX", "container.runtime must be an absolute path to docker or podman.");
  }
  const sandbox = { ...DEFAULT_SANDBOX, ...option, runtime };
  if (typeof sandbox.image !== "string" || !IMAGE_PATTERN.test(sandbox.image)) {
    throw new ContainerSandboxError("INVALID_SANDBOX", "container.image must be a plain image reference.");
  }
  for (const [key, min, max] of [["cpus", 0.1, 64], ["memoryBytes", 64 * 1024 ** 2, 256 * 1024 ** 3], ["pidsLimit", 16, 65_536], ["tmpfsBytes", 1024 ** 2, 4 * 1024 ** 3]]) {
    const value = sandbox[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new ContainerSandboxError("INVALID_SANDBOX", `container.${key} must be between ${min} and ${max}.`);
    }
  }
  try {
    accessSync(runtime, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new ContainerSandboxError("CONTAINER_UNAVAILABLE", `Container runtime '${runtime}' is not installed or not executable.`);
  }
  const probed = probe(runtime);
  if (!probed.ok) {
    throw new ContainerSandboxError("CONTAINER_UNAVAILABLE", `Container runtime '${runtime}' is not usable: ${probed.reason}`);
  }
  return Object.freeze(sandbox);
}

/** Asks the runtime for its server version; a stopped daemon fails here, not mid-task. */
export function probeRuntime(runtime) {
  const result = spawnSync(runtime, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8", timeout: 15_000, shell: false, windowsHide: true, env: minimalRuntimeEnvironment(),
  });
  if (result.error) return { ok: false, reason: result.error.code ?? result.error.message };
  if (result.status !== 0) return { ok: false, reason: String(result.stderr || "").trim().split("\n")[0] || `exit ${result.status}` };
  return { ok: true, version: String(result.stdout).trim() };
}

/**
 * The environment the runtime CLI itself needs (to find its socket), and
 * nothing more: never the daemon's credentials.
 */
export function minimalRuntimeEnvironment(source = process.env) {
  const keep = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "CONTAINER_HOST", "XDG_RUNTIME_DIR", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "TEMP", "TMP"];
  const environment = {};
  for (const key of keep) if (typeof source[key] === "string") environment[key] = source[key];
  return environment;
}

/** The container path matching a host cwd inside the workspace. */
export function containerWorkdir(workspaceRoot, cwd) {
  const rel = relative(workspaceRoot, cwd);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ContainerSandboxError("CWD_OUTSIDE_WORKSPACE", "cwd must be inside the workspace.");
  }
  return rel === "" ? CONTAINER_WORKDIR : `${CONTAINER_WORKDIR}/${rel.split(sep).join("/")}`;
}

/**
 * Pure: the runtime argv for one command. Kept free of I/O so the exact
 * isolation flags are testable without a container runtime.
 */
export function containerRunArguments({ sandbox, name, workspaceRoot, cwd, argv, env, network = false, interactive = false, user = currentUser() }) {
  if (!NAME_PATTERN.test(String(name))) throw new ContainerSandboxError("INVALID_INPUT", "container name is invalid.");
  if (!Array.isArray(argv) || argv.length === 0) throw new ContainerSandboxError("INVALID_INPUT", "argv must be a non-empty array.");
  // --mount is comma-separated; a comma in the path would add mount options.
  if (String(workspaceRoot).includes(",")) throw new ContainerSandboxError("INVALID_INPUT", "The workspace path cannot contain a comma.");
  const args = [
    "run", "--rm",
    "--name", name,
    "--network", network ? "bridge" : "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", `/tmp:rw,noexec,nosuid,size=${Math.floor(sandbox.tmpfsBytes)}`,
    "--pids-limit", String(Math.floor(sandbox.pidsLimit)),
    "--memory", String(Math.floor(sandbox.memoryBytes)),
    "--cpus", String(sandbox.cpus),
    "--mount", `type=bind,source=${workspaceRoot},target=${CONTAINER_WORKDIR}`,
    "--workdir", containerWorkdir(workspaceRoot, cwd),
  ];
  if (interactive) args.push("--interactive");
  if (user) args.push("--user", user);
  const containerEnv = {
    ...Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !CONTAINER_OWNED_KEYS.has(key))),
    HOME: CONTAINER_WORKDIR,
    TMPDIR: `${CONTAINER_WORKDIR}/.tmp`,
  };
  for (const [key, value] of Object.entries(containerEnv)) args.push("--env", `${key}=${value}`);
  args.push(sandbox.image, ...argv);
  return args;
}

function currentUser() {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return null;
  return `${process.getuid()}:${process.getgid()}`;
}

/** Removes a container by name; used when a command is cancelled or times out. */
export function killContainer(sandbox, name) {
  if (!NAME_PATTERN.test(String(name))) return false;
  const result = spawnSync(sandbox.runtime, ["rm", "--force", name], {
    timeout: 15_000, shell: false, windowsHide: true, stdio: "ignore", env: minimalRuntimeEnvironment(),
  });
  return !result.error && result.status === 0;
}
