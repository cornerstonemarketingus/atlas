import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Whether a session may work in the folder its owner named.
 *
 * The owner authorizes a repository by attaching it to a session (owner-only),
 * and every repository tool is then confined to that folder. Before this
 * check, a session could be created for a path that did not exist; the
 * failure surfaced only once a run had started, as a worktree error. Now the
 * session is refused up front, with the reason:
 *
 *   REPOSITORY_NOT_FOUND   the path does not exist, or is not a folder
 *   REPOSITORY_NOT_ABSOLUTE a relative path, which would resolve against
 *                          wherever the daemon happens to run
 *   NOT_A_GIT_REPOSITORY   the coder works in a Git worktree, so the folder
 *                          must be a Git checkout
 *
 * Only executors that work on this machine's filesystem are checked; a remote
 * executor's repository is an owner/name on its host, not a path here.
 */
const LOCAL_EXECUTORS = new Set(["local", "conversation"]);
const GIT_EXECUTORS = new Set(["local"]);

export function checkLocalRepository({ executor, repository }, { exists = existsSync, stat = statSync } = {}) {
  if (!LOCAL_EXECUTORS.has(executor) || typeof repository !== "string" || !repository) return null;
  if (!isAbsolute(repository)) {
    return { code: "REPOSITORY_NOT_ABSOLUTE", message: `'${repository}' is not an absolute path. Name the repository folder in full, for example C:\\path\\to\\project.` };
  }
  let info = null;
  try { info = stat(repository); } catch { info = null; }
  if (!info || !info.isDirectory()) {
    return { code: "REPOSITORY_NOT_FOUND", message: `No folder exists at '${repository}'. Check the path under "Where this conversation works" and try again.` };
  }
  if (GIT_EXECUTORS.has(executor) && !exists(join(repository, ".git"))) {
    return { code: "NOT_A_GIT_REPOSITORY", message: `'${repository}' is not a Git repository, and the coder works in an isolated Git worktree. Run \`git init\` there (and commit), or choose "conversation" to talk about the folder without the coder.` };
  }
  return null;
}
