import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_IDENTITY, GitError, commitConfig, git, refExists, resolveCommit } from "./git.mjs";

/**
 * Per-agent git worktree + branch manager (blueprint §7).
 *
 * Every child agent of an engineering task gets its own worktree on its own
 * branch, `atlas/<taskId>/<agentRole>`, created from a pinned base commit.
 *
 * Guarantees
 * - The operator's checkout is never written: worktrees are created with
 *   `git -C <repo> worktree add -b <branch> <path> <commit>`, which touches
 *   only the new directory and the repository's refs/worktree metadata. The
 *   worktree root must lie outside the checkout's working tree, so an agent
 *   worktree never shows up as untracked files there either.
 * - Branch names are generated, validated with `git check-ref-format`, must
 *   live under `atlas/`, and protected names (main, master, release, release/*,
 *   HEAD, the checkout's current branch) are refused for create and delete.
 * - `remove` only removes worktrees this manager's naming scheme owns, and
 *   never the main working tree.
 */
export class WorktreeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
}

export const BRANCH_PREFIX = "atlas/";
const PROTECTED_EXACT = new Set(["main", "master", "release", "head", "trunk", "production", "prod"]);
const PROTECTED_PREFIXES = ["release/", "releases/", "hotfix/"];
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** True for branch names an agent may never create, move or delete. */
export function isProtectedBranch(name) {
  if (typeof name !== "string" || name.length === 0) return true;
  const short = name.replace(/^refs\/heads\//, "");
  const lower = short.toLowerCase();
  if (PROTECTED_EXACT.has(lower)) return true;
  return PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function checkSegment(label, value) {
  if (typeof value !== "string" || !SEGMENT.test(value) || value.includes("..") || value.endsWith(".lock") || value.endsWith(".")) {
    throw new WorktreeError("INVALID_NAME", `${label} must be 1-80 characters of letters, digits, '.', '_' or '-', starting with a letter or digit.`);
  }
  return value;
}

/** `atlas/<taskId>/<agentRole>`; throws for unusable segments or protected results. */
export function agentBranchName(taskId, agentRole) {
  const branch = `${BRANCH_PREFIX}${checkSegment("taskId", taskId)}/${checkSegment("agentRole", agentRole)}`;
  assertAgentBranch(branch);
  return branch;
}

export function assertAgentBranch(branch) {
  if (isProtectedBranch(branch)) throw new WorktreeError("PROTECTED_BRANCH", `Branch '${branch}' is protected; agents may not use it.`);
  if (!String(branch).startsWith(BRANCH_PREFIX)) {
    throw new WorktreeError("PROTECTED_BRANCH", `Agent branches must live under '${BRANCH_PREFIX}'; refusing '${branch}'.`);
  }
  return branch;
}

export function isInside(parent, child) {
  // Windows paths are case-insensitive; comparing them case-sensitively lets
  // "C:\Repo\nested" pass as outside "c:/repo".
  const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const rel = relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The canonical form of a path that may not exist yet: the nearest existing
 * ancestor is resolved by the operating system (which also expands Windows
 * 8.3 short names such as RUNNER~1), and the missing tail is appended. Without
 * this a not-yet-created folder inside the checkout would compare as outside
 * it whenever the two paths were spelled differently.
 */
export function realOrResolved(path) {
  const absolute = resolve(path);
  const tail = [];
  let current = absolute;
  for (;;) {
    try { return join(realpathSync.native(current), ...tail.reverse()); }
    catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(current.slice(parent.length).replace(/^[\\/]+/u, ""));
      current = parent;
    }
  }
}

export class WorktreeManager {
  #repository;
  #rootDirectory;
  #identity;
  #toplevel = null;

  /**
   * @param {object} options
   * @param {string} options.repository     the operator's checkout (any path inside it)
   * @param {string} options.rootDirectory  where agent worktrees are created; must be outside the checkout
   * @param {{name: string, email: string}} [options.identity]  committer identity for agent commits
   */
  constructor({ repository, rootDirectory, identity = DEFAULT_IDENTITY } = {}) {
    if (typeof repository !== "string" || !repository) throw new WorktreeError("INVALID_INPUT", "A repository path is required.");
    if (typeof rootDirectory !== "string" || !rootDirectory) throw new WorktreeError("INVALID_INPUT", "A worktree rootDirectory is required.");
    this.#repository = resolve(repository);
    this.#rootDirectory = resolve(rootDirectory);
    this.#identity = identity;
  }

  get repository() { return this.#repository; }
  get rootDirectory() { return this.#rootDirectory; }
  get identity() { return this.#identity; }

  /** The main working tree's top level (resolved once). */
  async toplevel() {
    if (this.#toplevel) return this.#toplevel;
    const inside = await git(this.#repository, ["rev-parse", "--is-inside-work-tree"], { okCodes: [0, 128] });
    if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new WorktreeError("NOT_A_REPOSITORY", "The repository is not a git work tree.");
    const common = (await git(this.#repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    // The main worktree is the directory holding the common .git directory.
    const list = await this.#porcelain();
    const main = list.find((entry) => !entry.bare) ?? null;
    this.#toplevel = realOrResolved(main?.path ?? dirname(common));
    return this.#toplevel;
  }

  async #assertRootOutsideCheckout(path) {
    const top = await this.toplevel();
    if (isInside(top, realOrResolved(path))) {
      throw new WorktreeError("ROOT_INSIDE_CHECKOUT", "Agent worktrees must be created outside the operator's checkout.");
    }
  }

  async #currentBranch() {
    const result = await git(await this.toplevel(), ["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [0, 1, 128] });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  /**
   * Creates `atlas/<taskId>/<agentRole>` at `baseRef` checked out in a new
   * worktree. `path` overrides the default `<root>/<taskId>/<agentRole>`
   * (used to place the worktree inside a terminal workspace).
   */
  async create({ taskId, agentRole, baseRef = "HEAD", path = undefined } = {}) {
    const branch = agentBranchName(taskId, agentRole);
    if (branch === await this.#currentBranch()) throw new WorktreeError("PROTECTED_BRANCH", "Refusing to reuse the checkout's current branch.");
    const top = await this.toplevel();
    let baseCommit;
    try {
      baseCommit = await resolveCommit(top, baseRef);
    } catch {
      throw new WorktreeError("UNKNOWN_BASE", `Base '${String(baseRef).slice(0, 80)}' is not a commit in the repository.`);
    }
    if (await refExists(top, `refs/heads/${branch}`)) throw new WorktreeError("BRANCH_EXISTS", `Branch '${branch}' already exists.`);

    const target = resolve(path ?? join(this.#rootDirectory, taskId, agentRole));
    if (path === undefined) mkdirSync(this.#rootDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    await this.#assertRootOutsideCheckout(dirname(target));
    await git(top, ["worktree", "add", "--quiet", "-b", branch, target, baseCommit]);
    return { taskId, agentRole, branch, path: realOrResolved(target), baseCommit };
  }

  /**
   * Adds a worktree for an existing agent branch (e.g. an integration branch
   * produced by a reviewed merge). Protected branches are refused.
   */
  async checkout({ branch, path } = {}) {
    assertAgentBranch(branch);
    const top = await this.toplevel();
    if (!await refExists(top, `refs/heads/${branch}`)) throw new WorktreeError("UNKNOWN_BRANCH", `Branch '${branch}' does not exist.`);
    const target = resolve(path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    await this.#assertRootOutsideCheckout(dirname(target));
    await git(top, ["worktree", "add", "--quiet", target, branch]);
    return { branch, path: realOrResolved(target), baseCommit: await resolveCommit(top, branch) };
  }

  async #porcelain() {
    const { stdout } = await git(this.#repository, ["worktree", "list", "--porcelain"]);
    const entries = [];
    let current = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        current = { path: line.slice(9), head: null, branch: null, bare: false, detached: false, prunable: false };
        entries.push(current);
      } else if (!current) {
        continue;
      } else if (line.startsWith("HEAD ")) current.head = line.slice(5);
      else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") current.bare = true;
      else if (line === "detached") current.detached = true;
      else if (line.startsWith("prunable")) current.prunable = true;
    }
    return entries;
  }

  /** Agent worktrees (branches under `atlas/`), optionally for one task. */
  async list({ taskId = undefined } = {}) {
    const entries = await this.#porcelain();
    return entries
      .filter((entry) => entry.branch?.startsWith(BRANCH_PREFIX))
      .map((entry) => {
        const [, task, ...role] = entry.branch.split("/");
        return { taskId: task, agentRole: role.join("/"), branch: entry.branch, path: entry.path, head: entry.head, prunable: entry.prunable };
      })
      .filter((entry) => taskId === undefined || entry.taskId === taskId);
  }

  /**
   * Removes an agent worktree (by `path` or `branch`). The main working tree
   * and non-agent worktrees are refused. `deleteBranch` also deletes the
   * branch, which must be an agent branch.
   */
  async remove({ path = undefined, branch = undefined, force = true, deleteBranch = false } = {}) {
    const top = await this.toplevel();
    const entries = await this.list();
    const wanted = path !== undefined ? realOrResolved(path) : null;
    const entry = entries.find((item) => (wanted !== null ? realOrResolved(item.path) === wanted : item.branch === branch));
    if (wanted !== null && wanted === top) throw new WorktreeError("MAIN_WORKTREE", "Refusing to remove the operator's checkout.");
    if (!entry) throw new WorktreeError("UNKNOWN_WORKTREE", "No agent worktree matches that path or branch.");
    if (realOrResolved(entry.path) === top) throw new WorktreeError("MAIN_WORKTREE", "Refusing to remove the operator's checkout.");
    assertAgentBranch(entry.branch);
    await git(top, ["worktree", "remove", ...(force ? ["--force"] : []), entry.path], { okCodes: [0, 128] });
    await git(top, ["worktree", "prune"]);
    if (deleteBranch) await this.deleteBranch(entry.branch);
    return { branch: entry.branch, path: entry.path, removed: true, branchDeleted: deleteBranch };
  }

  async deleteBranch(branch) {
    assertAgentBranch(branch);
    if (branch === await this.#currentBranch()) throw new WorktreeError("PROTECTED_BRANCH", "Refusing to delete the checkout's current branch.");
    await git(await this.toplevel(), ["branch", "-D", "--quiet", branch], { okCodes: [0, 1] });
  }

  /**
   * Stages everything in an agent worktree and commits it on the agent
   * branch. Returns the new commit, or null when nothing changed. Hooks and
   * signing are disabled for the commit.
   */
  async commitAll(handle, message) {
    const cwd = handle.path;
    const branch = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [0, 1] })).stdout.trim();
    if (branch !== handle.branch) throw new WorktreeError("BRANCH_MISMATCH", `Worktree is on '${branch}', expected '${handle.branch}'.`);
    assertAgentBranch(branch);
    await git(cwd, ["add", "-A"]);
    const staged = await git(cwd, ["diff", "--cached", "--quiet"], { okCodes: [0, 1] });
    if (staged.code === 0) return null;
    try {
      await git(cwd, [...commitConfig(this.#identity), "commit", "--quiet", "--no-verify", "-m", message]);
    } catch (error) {
      if (error instanceof GitError) throw new WorktreeError("COMMIT_FAILED", error.message);
      throw error;
    }
    return resolveCommit(cwd, "HEAD");
  }
}
