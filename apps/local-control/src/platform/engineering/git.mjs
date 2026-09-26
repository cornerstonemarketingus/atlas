import { execFile } from "node:child_process";

/**
 * Minimal git CLI wrapper for the engineering workflow (blueprint §7).
 *
 * - argv only, `execFile` with no shell: nothing here is ever parsed as shell.
 * - Variables that could redirect git at another repository or index
 *   (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...) are stripped, so a caller
 *   running under a git hook cannot make these helpers act on the wrong tree.
 * - Prompts are disabled; a command that would ask for credentials fails.
 * - Commits made here never run repository hooks and never sign: the repo's
 *   own hooks are untrusted code from the agent's point of view.
 */
export class GitError extends Error {
  constructor(message, { args = [], code = null, stderr = "" } = {}) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.exitCode = code;
    this.stderr = stderr;
  }
}

const REDIRECTING_VARIABLES = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_PREFIX",
];

export const DEFAULT_IDENTITY = Object.freeze({ name: "Atlas", email: "atlas@users.noreply.invalid" });

function gitEnvironment(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const key of REDIRECTING_VARIABLES) delete env[key];
  return { ...env, ...extra };
}

/**
 * Runs git and resolves `{ code, stdout, stderr }`. Rejects with GitError when
 * the exit code is not listed in `okCodes` (default `[0]`).
 */
export function git(cwd, args, { okCodes = [0], env = {}, maxBuffer = 32 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
  return new Promise((resolveGit, rejectGit) => {
    execFile("git", args, { cwd, env: gitEnvironment(env), maxBuffer, timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
      if (error && code === null) {
        rejectGit(new GitError(`git ${args[0]} could not run: ${error.message}`, { args, stderr }));
        return;
      }
      if (!okCodes.includes(code)) {
        rejectGit(new GitError(`git ${args.join(" ").slice(0, 200)} exited ${code}: ${String(stderr).trim().slice(0, 500)}`, { args, code, stderr }));
        return;
      }
      resolveGit({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** `-c` options that keep commits made by Atlas from running hooks or signing. */
export function commitConfig(identity = DEFAULT_IDENTITY) {
  return [
    "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`,
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
  ];
}

export function identityEnvironment(identity = DEFAULT_IDENTITY) {
  return {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  };
}

export async function resolveCommit(repository, ref) {
  const { stdout } = await git(repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return stdout.trim();
}

export async function refExists(repository, ref) {
  const { code } = await git(repository, ["show-ref", "--verify", "--quiet", ref], { okCodes: [0, 1] });
  return code === 0;
}

/** Files changed between two commits, with numstat line counts. */
export async function diffStats(repository, base, head) {
  const { stdout } = await git(repository, ["diff", "--numstat", "--no-renames", "-z", base, head]);
  const files = [];
  // -z numstat: "<added>\t<deleted>\t<path>\0" per file.
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const [added, deleted, ...rest] = record.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const binary = added === "-" || deleted === "-";
    files.push({ path, added: binary ? null : Number(added), deleted: binary ? null : Number(deleted), binary });
  }
  const totals = files.reduce((sum, file) => ({
    files: sum.files + 1, added: sum.added + (file.added ?? 0), deleted: sum.deleted + (file.deleted ?? 0),
  }), { files: 0, added: 0, deleted: 0 });
  return { files, totals };
}

/**
 * Added lines between two commits, as `{ path, line, text }` where `line` is
 * the line number in the new file. Binary files contribute nothing.
 */
export async function addedLines(repository, base, head) {
  const { stdout } = await git(repository, ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--unified=0", base, head]);
  const lines = [];
  let path = null;
  let next = 0;
  for (const raw of stdout.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4);
      path = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (path && raw.startsWith("+")) {
      lines.push({ path, line: next, text: raw.slice(1) });
      next += 1;
    }
  }
  return lines;
}
