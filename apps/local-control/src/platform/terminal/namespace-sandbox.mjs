import { spawnSync } from "node:child_process";
import { accessSync, constants, lchownSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Linux namespace isolation for the terminal controller — the lighter
 * alternative to container-sandbox.mjs for hosts with no container runtime.
 *
 * With `namespaces` configured, every command runs in fresh namespaces:
 *
 * - network: a new network namespace holding only a down loopback, so no
 *   connection of any kind leaves it (not even to host 127.0.0.1). A command
 *   the policy approved as network-enabled keeps the HOST network — there is
 *   no egress filter — and its isolation record says `network: "host"`.
 * - pid: a new PID namespace with its own /proc; host processes are neither
 *   visible nor signalable. When the command times out or is cancelled the
 *   namespace's init dies and the kernel kills everything in it, including
 *   grandchildren that left the process group.
 * - filesystem: a new mount namespace where every mount is remounted
 *   read-only (`ro=recursive`), /tmp and /dev/shm are private tmpfs, the
 *   workspace root is covered by an empty tmpfs (sibling workspaces are not
 *   visible) and the workspace is the only writable host directory, bound at
 *   its own path so argv paths the policy checked stay valid.
 * - user: uid/gid 65534 with no capabilities and no_new_privs. IPC, UTS and
 *   cgroup namespaces are new too.
 *
 * Tools and modes:
 *   unshare/root    daemon runs as root: util-linux `unshare`, then `setpriv`
 *                   drops to the real host uid 65534 with an empty bounding
 *                   set. The workspace tree is chowned to 65534 before each
 *                   command (symlinks are never followed).
 *   unshare/userns  unprivileged daemon: an outer user namespace maps the
 *                   daemon's uid to root for the mount setup; the command runs
 *                   as 65534 in a nested user namespace, which is still the
 *                   daemon's own uid on the host.
 *   bwrap           bubblewrap (unprivileged daemons only): --unshare-all,
 *                   --ro-bind / /, private /proc /dev /tmp, the workspace root
 *                   covered by tmpfs and the workspace bound writable,
 *                   --die-with-parent, uid 65534, --cap-drop ALL.
 *
 * Resolution runs a probe inside a real sandbox under the controller's
 * workspace root and checks the claims (uid, read-only root, writable
 * workspace, no interfaces, few pids). If anything fails, the option throws:
 * asking for isolation never silently yields the plain process runner.
 *
 * Not provided: no seccomp filter and no cgroup memory/CPU/pids limits (the
 * controller's rlimits still apply); the host kernel is shared, so a kernel
 * bug is an escape. The namespace setup is a fixed, controller-owned `sh`
 * script — nothing a model writes is interpolated into it; paths and the
 * command argv arrive as positional parameters and run as `"$@"`.
 */

export class NamespaceSandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NamespaceSandboxError";
    this.code = code;
  }
}

export const SANDBOX_UID = 65534;
export const SANDBOX_GID = 65534;

const SYSTEM_BIN = Object.freeze(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
const DEFAULTS = Object.freeze({ tool: "auto", tmpfsBytes: 64 * 1024 ** 2 });

// PID 1 of the new namespaces: sets up mounts as (namespace) root, then runs
// the command as a child with dropped privileges. It stays alive as init so
// the kernel tears the namespace down when it dies (the outer unshare has
// --kill-child, so killing the process group kills init, then everything).
const SETUP_SCRIPT = [
  "set -u",
  "fail() { echo \"atlas-sandbox: $1\" >&2; exit 125; }",
  "MOUNT=$1; MKDIR=$2; SETPRIV=$3; UNSHARE=$4; MODE=$5; WS=$6; WSROOT=$7; CWD=$8; TMPFS=$9; shift 9",
  "\"$MOUNT\" --make-rprivate / || fail 'make-rprivate failed'",
  "exec 3<\"$WS\" || fail 'cannot open workspace'",
  "\"$MOUNT\" -o remount,bind,ro=recursive / || fail 'recursive read-only remount failed'",
  "\"$MOUNT\" -t tmpfs -o mode=1777,nosuid,nodev,size=\"$TMPFS\" tmpfs /tmp || fail 'private /tmp failed'",
  "if [ -d /dev/shm ]; then \"$MOUNT\" -t tmpfs -o mode=1777,nosuid,nodev,noexec,size=\"$TMPFS\" tmpfs /dev/shm || fail 'private /dev/shm failed'; fi",
  "\"$MKDIR\" -p \"$WSROOT\" || fail 'workspace root missing'",
  "\"$MOUNT\" -t tmpfs -o mode=0755,nosuid,nodev,size=1m tmpfs \"$WSROOT\" || fail 'cannot cover workspace root'",
  "\"$MKDIR\" \"$WS\" || fail 'cannot create workspace mountpoint'",
  // The workspace was covered above; the fd opened earlier still reaches it.
  "\"$MOUNT\" --no-canonicalize --bind /proc/self/fd/3 \"$WS\" || fail 'workspace bind failed'",
  "\"$MOUNT\" -o remount,bind,rw,nosuid,nodev \"$WS\" || fail 'workspace remount failed'",
  "exec 3<&-",
  "cd \"$CWD\" || fail 'cannot enter cwd'",
  "if [ \"$MODE\" = root ]; then",
  `  "$SETPRIV" --reuid=${SANDBOX_UID} --regid=${SANDBOX_GID} --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- "$@"`,
  "else",
  `  "$UNSHARE" --user --map-user=${SANDBOX_UID} --map-group=${SANDBOX_GID} -- "$SETPRIV" --no-new-privs -- "$@"`,
  "fi",
  "exit $?",
].join("\n");

// Run inside a real sandbox at resolution time: verifies the claims, not just the tools.
const PROBE_SCRIPT = [
  `[ "$(id -u)" = ${SANDBOX_UID} ] || { echo "uid is $(id -u)" >&2; exit 1; }`,
  "if ( : >/.atlas-sandbox-probe ) 2>/dev/null; then echo 'root filesystem is writable' >&2; exit 1; fi",
  "( : > ./.atlas-probe ) || { echo 'workspace not writable' >&2; exit 1; }",
  "rm -f ./.atlas-probe",
  "if grep -v -E '^ *(lo|Inter|face)' /proc/net/dev | grep -q .; then echo 'network interfaces present' >&2; exit 1; fi",
  "[ \"$(ls /proc | grep -c -E '^[0-9]+$')\" -lt 10 ] || { echo 'host processes visible' >&2; exit 1; }",
].join("\n");

function findTool(name) {
  for (const directory of SYSTEM_BIN) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

function hostUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Changes ownership of a tree without following symlinks. */
export function chownTree(path, uid, gid) {
  let stat;
  try { stat = lstatSync(path); } catch { return; }
  if (stat.uid !== uid || stat.gid !== gid) lchownSync(path, uid, gid);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) chownTree(join(path, entry), uid, gid);
  }
}

/**
 * Normalizes the `namespaces` option. Returns null when none was asked for;
 * throws NAMESPACES_UNAVAILABLE when one was asked for and cannot work here.
 */
export function resolveNamespaceSandbox(option, { rootDirectory = undefined, probe = probeNamespaceSandbox } = {}) {
  if (option === undefined || option === null || option === false) return null;
  const given = option === true ? {} : option;
  if (typeof given !== "object" || Array.isArray(given)) {
    throw new NamespaceSandboxError("INVALID_SANDBOX", "namespaces must be true or an object such as { tool: 'unshare' }.");
  }
  const config = { ...DEFAULTS, ...given };
  if (!["auto", "unshare", "bwrap"].includes(config.tool)) {
    throw new NamespaceSandboxError("INVALID_SANDBOX", "namespaces.tool must be 'auto', 'unshare' or 'bwrap'.");
  }
  if (!Number.isInteger(config.tmpfsBytes) || config.tmpfsBytes < 1024 ** 2 || config.tmpfsBytes > 4 * 1024 ** 3) {
    throw new NamespaceSandboxError("INVALID_SANDBOX", "namespaces.tmpfsBytes must be an integer between 1 MiB and 4 GiB.");
  }
  if (process.platform !== "linux") {
    throw new NamespaceSandboxError("NAMESPACES_UNAVAILABLE", `Namespace isolation is Linux-only (this host is ${process.platform}).`);
  }
  const reasons = [];
  for (const tool of config.tool === "auto" ? ["unshare", "bwrap"] : [config.tool]) {
    const candidate = describeTool(tool, config);
    if (candidate.reason) { reasons.push(`${tool}: ${candidate.reason}`); continue; }
    const probed = probe(candidate.sandbox, rootDirectory);
    if (probed.ok) return Object.freeze(candidate.sandbox);
    reasons.push(`${tool}: ${probed.reason}`);
  }
  throw new NamespaceSandboxError("NAMESPACES_UNAVAILABLE", `Namespace isolation is not usable here — ${reasons.join("; ")}`);
}

function describeTool(tool, config) {
  const uid = hostUid();
  const tmpfs = String(config.tmpfsBytes);
  if (tool === "unshare") {
    const paths = { unshare: findTool("unshare"), mount: findTool("mount"), mkdir: findTool("mkdir"), setpriv: findTool("setpriv"), sh: findTool("sh") };
    const missing = Object.entries(paths).filter(([, path]) => !path).map(([name]) => name);
    if (missing.length > 0) return { reason: `missing ${missing.join(", ")}` };
    const mode = uid === 0 ? "root" : "userns";
    return { sandbox: { tool, mode, paths, tmpfsBytes: config.tmpfsBytes, tmpfs } };
  }
  const bwrap = findTool("bwrap");
  if (!bwrap) return { reason: "bwrap is not installed" };
  // As root, bwrap's user namespace would map uid 65534 onto host uid 0.
  if (uid === 0) return { reason: "refused for a root daemon (the sandbox uid would be host root); use unshare" };
  return { sandbox: { tool, mode: "userns", paths: { bwrap }, tmpfsBytes: config.tmpfsBytes, tmpfs } };
}

/** Runs the probe script in a throwaway workspace laid out like a real one. */
export function probeNamespaceSandbox(sandbox, rootDirectory = undefined) {
  let base = null;
  let workspace = null;
  try {
    if (!rootDirectory) base = mkdtempSync(join(tmpdir(), "atlas-ns-probe-"));
    const root = rootDirectory ?? base;
    workspace = mkdtempSync(join(root, ".atlas-ns-probe-"));
    prepareNamespaceWorkspace(sandbox, workspace);
    const shell = findTool("sh");
    const { file, args } = namespaceRunArguments({
      sandbox, file: shell, args: ["-c", PROBE_SCRIPT], network: false, workspaceRoot: workspace, rootDirectory: root, cwd: workspace,
    });
    const result = spawnSync(file, args, { cwd: workspace, env: { PATH: SYSTEM_BIN.join(":"), LANG: "C" }, timeout: 15_000, encoding: "utf8" });
    if (result.status === 0) return { ok: true };
    const detail = String(result.stderr || result.error?.message || `exit ${result.status}`).trim().split("\n").slice(-2).join("; ");
    return { ok: false, reason: `probe failed: ${detail}`.slice(0, 400) };
  } catch (error) {
    return { ok: false, reason: `probe failed: ${error.message}` };
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    if (base) rmSync(base, { recursive: true, force: true });
  }
}

/** Makes the workspace usable by the sandbox uid (root mode only). */
export function prepareNamespaceWorkspace(sandbox, directory) {
  if (sandbox.tool === "unshare" && sandbox.mode === "root") chownTree(directory, SANDBOX_UID, SANDBOX_GID);
}

/**
 * Pure: the spawn file and argv for one command. `file` must already be an
 * absolute host path (the same filesystem is visible, read-only).
 */
export function namespaceRunArguments({ sandbox, file, args, network = false, workspaceRoot, rootDirectory, cwd }) {
  if (sandbox.tool === "bwrap") {
    return {
      file: sandbox.paths.bwrap,
      args: [
        "--unshare-all", ...(network ? ["--share-net"] : []),
        "--die-with-parent",
        "--ro-bind", "/", "/",
        "--dev", "/dev", "--proc", "/proc",
        "--size", sandbox.tmpfs, "--tmpfs", "/tmp",
        "--tmpfs", rootDirectory,
        "--bind", workspaceRoot, workspaceRoot,
        "--chdir", cwd,
        "--uid", String(SANDBOX_UID), "--gid", String(SANDBOX_GID),
        "--cap-drop", "ALL",
        "--", file, ...args,
      ],
    };
  }
  const { paths, mode } = sandbox;
  return {
    file: paths.unshare,
    args: [
      ...(mode === "userns" ? ["--user", "--map-root-user"] : []),
      ...(network ? [] : ["--net"]),
      "--pid", "--fork", "--kill-child", "--mount-proc", "--mount", "--ipc", "--uts", "--cgroup",
      "--", paths.sh, "-c", SETUP_SCRIPT, "atlas-sandbox",
      paths.mount, paths.mkdir, paths.setpriv, paths.unshare, mode, workspaceRoot, rootDirectory, cwd, sandbox.tmpfs,
      file, ...args,
    ],
  };
}

/** What a namespaced command actually gets, for the result's isolation record. */
export function namespaceIsolation(sandbox, { network, workspaceRoot }) {
  const rootMode = sandbox.tool === "unshare" && sandbox.mode === "root";
  return {
    tool: sandbox.tool,
    mode: sandbox.mode,
    network: network ? "host" : "none",
    pid: "isolated",
    fs: "readonly-root",
    user: { uid: SANDBOX_UID, gid: SANDBOX_GID, hostUid: rootMode ? SANDBOX_UID : hostUid(), userNamespace: !rootMode },
    noNewPrivs: true,
    capabilities: "none",
    writable: [workspaceRoot, "/tmp (private tmpfs)", ...(sandbox.tool === "unshare" ? ["/dev/shm (private tmpfs)"] : [])],
    siblingWorkspacesHidden: true,
    notes: [
      ...(network ? ["network-enabled: HOST network namespace, no egress filter (approved high-risk command)"] : []),
      "shared host kernel, no seccomp filter, no cgroup limits (rlimits only)",
    ],
  };
}
