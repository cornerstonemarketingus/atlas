import { resolve } from "node:path";
import { confineRealPath } from "../../agent/tools/path-confinement.mjs";

/**
 * Command policy for the terminal controller.
 *
 * Decides, before anything is spawned, whether an argv may run in a workspace
 * and how risky it is. The policy is layered so each layer fails closed on its
 * own:
 *
 *   1. shape — argv is an array of bounded strings; the executable is a bare
 *      name (no path), so it is always resolved against the controller's own
 *      minimal PATH rather than something the model dropped into the workspace;
 *   2. always-denied executables — privilege changers, shells, container and
 *      process-control tools are refused even if an operator adds them to the
 *      allowlist, because each one is a way out of every other check;
 *   3. allowlist — only named executables run at all;
 *   4. per-tool rules — git, npm, rm, sed and chmod subcommands that publish,
 *      touch global configuration or escape the workspace are refused;
 *   5. argument paths — any path-like token (absolute, `..`, or relative
 *      through a symlink) that resolves outside the workspace is refused.
 *
 * Stated plainly: allowlisting `node` or `python3` allows arbitrary code, and
 * that code can open any file the host user can. These rules stop an agent
 * from *casually* reaching outside its workspace through argv; they are not a
 * sandbox. Real isolation needs a container or VM (see terminal-controller.mjs).
 */
export class TerminalPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TerminalPolicyError";
    this.code = code;
  }
}

export const DEFAULT_ALLOWED_EXECUTABLES = Object.freeze([
  "node", "npm", "npx", "git", "python3",
  "ls", "cat", "echo", "pwd", "grep", "sed", "true", "false",
  "head", "tail", "wc", "mkdir", "touch", "rm", "cp", "mv", "diff", "sort",
]);

/** Refused regardless of the allowlist. */
const ALWAYS_DENIED = new Set([
  "sudo", "su", "doas", "pkexec", "runuser", "chroot", "nsenter", "unshare", "setpriv", "capsh",
  "mount", "umount", "losetup", "mkfs", "dd", "fdisk",
  "docker", "podman", "kubectl", "nerdctl", "ctr", "lxc", "systemctl", "service", "launchctl",
  "shutdown", "reboot", "halt", "poweroff", "init",
  "kill", "pkill", "killall", "skill",
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "busybox",
  "env", "xargs", "nohup", "setsid", "timeout", "nice", "ionice", "stdbuf", "script", "expect",
  "strace", "ltrace", "gdb", "crontab", "at", "passwd", "chpasswd", "useradd", "usermod",
  "iptables", "nft", "ip", "ifconfig", "prlimit", "chattr",
]);

/** Tools whose whole purpose is the network; allowed only with `network: true`. */
const NETWORK_EXECUTABLES = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet"]);

const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_ARGS = 256;
const MAX_ARG_LENGTH = 32 * 1024;

/** Absolute paths outside the workspace that are harmless to name. */
const SAFE_ABSOLUTE_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]);

/** Splits an argument into path-like tokens: quotes, brackets, `=`, `,`, `;` and whitespace end a token. */
const TOKEN_SEPARATORS = /[\s'"`=(),;[\]{}]+/;
const PARENT_SEGMENT = /(^|\/)\.\.(\/|$)/;

const GIT_DENIED_SUBCOMMANDS = new Set(["push", "credential", "credential-store", "credential-cache", "send-email", "daemon", "http-backend", "upload-pack", "receive-pack", "filter-branch"]);
const GIT_NETWORK_SUBCOMMANDS = new Set(["clone", "fetch", "pull", "ls-remote", "submodule", "remote"]);
const GIT_HIGH_SUBCOMMANDS = new Set(["commit", "merge", "rebase", "reset", "clean", "cherry-pick", "revert", "tag", "am", "apply", "gc", "prune"]);
/** Global git options that can execute programs or read configuration from elsewhere. */
const GIT_DENIED_GLOBAL_OPTIONS = /^(-c|--config-env|--exec-path|--upload-pack|--receive-pack|--git-dir|--work-tree|--namespace|--super-prefix)(=|$)/;
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

const NPM_DENIED_SUBCOMMANDS = new Set(["publish", "unpublish", "adduser", "add-user", "login", "logout", "token", "owner", "deprecate", "access", "team", "star", "unstar", "dist-tag", "profile", "org", "hook", "undeprecate"]);
const NPM_HIGH_SUBCOMMANDS = new Set(["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isntall", "add", "ci", "clean-install", "update", "up", "upgrade", "exec", "x", "rebuild", "link", "ln", "audit", "init", "create", "pack", "dedupe", "prune", "uninstall", "remove", "rm", "r", "un"]);

/**
 * Evaluates an argv against the policy. Throws TerminalPolicyError when it is
 * refused; otherwise returns `{ executable, risk, reasons }`, where a `high`
 * risk means the controller must obtain approval before spawning.
 */
export function evaluateCommand({ argv, workspaceRoot, cwd, network = false, allowedExecutables = DEFAULT_ALLOWED_EXECUTABLES }) {
  assertArgvShape(argv);
  const [executable, ...args] = argv;
  const reasons = [];
  let risk = "low";
  const raise = (level, reason) => {
    const order = ["low", "moderate", "high"];
    if (order.indexOf(level) > order.indexOf(risk)) risk = level;
    reasons.push(reason);
  };

  if (!EXECUTABLE_NAME.test(executable)) {
    throw new TerminalPolicyError("EXECUTABLE_NOT_BARE", "The executable must be a bare command name, not a path.");
  }
  if (ALWAYS_DENIED.has(executable)) {
    throw new TerminalPolicyError("EXECUTABLE_DENIED", `'${executable}' is never permitted in a workspace.`);
  }
  if (NETWORK_EXECUTABLES.has(executable) && !network) {
    throw new TerminalPolicyError("NETWORK_NOT_ENABLED", `'${executable}' needs network access, which was not enabled for this command.`);
  }
  if (!allowedExecutables.includes(executable)) {
    throw new TerminalPolicyError("EXECUTABLE_NOT_ALLOWED", `'${executable}' is not on the workspace executable allowlist.`);
  }
  if (network) raise("high", "network access requested");

  switch (executable) {
    case "git": checkGit(args, raise); break;
    case "npm": checkNpm(args, raise); break;
    case "npx": raise("high", "npx downloads and runs packages"); break;
    case "node": case "python3": checkInterpreter(executable, args, raise); break;
    case "rm": checkRm(args, workspaceRoot, cwd); raise("moderate", "deletes files"); break;
    case "mv": case "cp": raise("moderate", "modifies files"); break;
    case "sed": checkSed(args); break;
    case "chmod": checkChmod(args); raise("moderate", "changes permissions"); break;
    default: break;
  }

  checkArgumentPaths(args, workspaceRoot, cwd);
  return { executable, risk, reasons };
}

function assertArgvShape(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGS) {
    throw new TerminalPolicyError("INVALID_ARGV", `argv must be a non-empty array of at most ${MAX_ARGS} strings.`);
  }
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || arg.includes("\0")) {
      throw new TerminalPolicyError("INVALID_ARGV", "Every argv entry must be a string without NUL bytes and under 32 KiB.");
    }
  }
  if (argv[0].length === 0) throw new TerminalPolicyError("INVALID_ARGV", "The executable name is empty.");
}

function checkGit(args, raise) {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    const option = args[index];
    if (GIT_DENIED_GLOBAL_OPTIONS.test(option)) {
      throw new TerminalPolicyError("GIT_OPTION_DENIED", `git option '${option.split("=")[0]}' is not permitted.`);
    }
    index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  const subcommand = args[index];
  if (subcommand === undefined) return;
  const rest = args.slice(index + 1);
  if (GIT_DENIED_SUBCOMMANDS.has(subcommand)) {
    throw new TerminalPolicyError("GIT_SUBCOMMAND_DENIED", `'git ${subcommand}' is not permitted from a workspace.`);
  }
  if (subcommand === "config" && rest.some((arg) => /^--(global|system|file|blob)(=|$)/.test(arg) || arg === "-f")) {
    throw new TerminalPolicyError("GIT_SUBCOMMAND_DENIED", "git config may only touch the workspace repository's own configuration.");
  }
  if (subcommand === "config" && rest.some((arg) => /^(core\.(sshCommand|hooksPath|fsmonitor|editor|pager|askPass)|credential\.|url\.|.*\.helper$)/i.test(arg))) {
    throw new TerminalPolicyError("GIT_SUBCOMMAND_DENIED", "git config keys that run programs or rewrite remotes are not permitted.");
  }
  if (GIT_NETWORK_SUBCOMMANDS.has(subcommand)) raise("high", `git ${subcommand} reaches a remote`);
  if (GIT_HIGH_SUBCOMMANDS.has(subcommand)) raise("high", `git ${subcommand} rewrites repository history or state`);
}

function checkNpm(args, raise) {
  if (args.some((arg) => arg === "-g" || /^--(global|location=global|prefix|userconfig|globalconfig)(=|$)/.test(arg))) {
    throw new TerminalPolicyError("NPM_GLOBAL_DENIED", "npm may only operate on the workspace, not on global state.");
  }
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  if (subcommand === undefined) return;
  if (NPM_DENIED_SUBCOMMANDS.has(subcommand)) {
    throw new TerminalPolicyError("NPM_SUBCOMMAND_DENIED", `'npm ${subcommand}' is not permitted from a workspace.`);
  }
  if (subcommand === "config" && args.some((arg) => arg === "set" || arg === "delete" || arg === "edit")) {
    throw new TerminalPolicyError("NPM_SUBCOMMAND_DENIED", "npm config may not be modified from a workspace.");
  }
  if (NPM_HIGH_SUBCOMMANDS.has(subcommand)) raise("high", `npm ${subcommand} fetches packages or runs lifecycle scripts`);
  else raise("moderate", `npm ${subcommand} runs package scripts`);
}

function checkInterpreter(executable, args, raise) {
  if (executable === "python3") {
    const moduleIndex = args.indexOf("-m");
    if (moduleIndex !== -1 && /^(pip|ensurepip|venv|http\.server|smtpd)$/.test(args[moduleIndex + 1] ?? "")) {
      raise("high", `python3 -m ${args[moduleIndex + 1]} installs packages or opens a server`);
    }
  }
  raise("moderate", `${executable} executes arbitrary code as the host user`);
}

function checkRm(args, workspaceRoot, cwd) {
  if (args.some((arg) => arg === "--no-preserve-root")) {
    throw new TerminalPolicyError("RM_DENIED", "rm --no-preserve-root is not permitted.");
  }
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === "--") { optionsEnded = true; continue; }
    if (!optionsEnded && arg.startsWith("-")) continue;
    const target = resolveConfined(workspaceRoot, cwd, arg);
    if (target === workspaceRoot) {
      throw new TerminalPolicyError("RM_DENIED", "rm may not remove the workspace root itself; destroy the workspace instead.");
    }
  }
}

/** GNU sed's `e` command and `s///e` flag run a shell. */
function checkSed(args) {
  for (const arg of args) {
    if (/(^|[;\n{}])\s*[0-9$,~+]*!?\s*e(\s|$|;)/.test(arg) || /^s(.).*\1.*\1[gpiImM0-9w]*e[gpiImM0-9]*\s*$/.test(arg)) {
      throw new TerminalPolicyError("SED_EXEC_DENIED", "sed scripts that execute commands are not permitted.");
    }
  }
}

function checkChmod(args) {
  for (const arg of args) {
    if (/^[0-7]*[2467][0-7]{3}$/.test(arg) && arg.length >= 4 || /^[ugoa]*[+=][rwxXt]*s/.test(arg)) {
      throw new TerminalPolicyError("CHMOD_DENIED", "Setting setuid or setgid bits is not permitted.");
    }
  }
}

/**
 * Refuses any absolute or `..` path in the arguments that resolves outside
 * the workspace. Paths are found both as whole arguments and embedded inside
 * them (`--out=/etc/x`, `-e "read('/etc/passwd')"`): a false positive costs
 * the agent a rephrase, a false negative costs the host a file.
 */
function checkArgumentPaths(args, workspaceRoot, cwd) {
  for (const arg of args) {
    for (const token of arg.split(TOKEN_SEPARATORS)) {
      if (token.length === 0) continue;
      if (token.startsWith("~")) {
        throw new TerminalPolicyError("PATH_OUTSIDE_WORKSPACE", "Home-relative paths are not permitted; use workspace-relative paths.");
      }
      // `//` starts a URL's authority or a comment, not a path.
      const absolute = token.startsWith("/") && !token.startsWith("//");
      if (absolute && SAFE_ABSOLUTE_PATHS.has(token)) continue;
      if (absolute || PARENT_SEGMENT.test(token)) {
        if (!token.includes("://")) resolveConfined(workspaceRoot, cwd, token);
        continue;
      }
      // A plain relative token can still leave the workspace through a
      // symlink inside it (`link/passwd` where `link -> /etc`); resolving it
      // is cheap and a token that names nothing on disk resolves inside.
      if (!token.includes("://") && !token.startsWith("-")) resolveConfined(workspaceRoot, cwd, token);
    }
  }
}

function resolveConfined(workspaceRoot, cwd, candidate) {
  return confineRealPath(workspaceRoot, resolve(cwd, candidate), (code, message) => {
    return new TerminalPolicyError(code === "PATH_ESCAPES_ROOT" ? "PATH_OUTSIDE_WORKSPACE" : code, message);
  });
}
