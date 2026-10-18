import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { git } from "./git.mjs";

function inside(root, relative) {
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`path escapes the workspace: ${relative}`);
  return target;
}

/** Writes `path` as it is at `commit`, or removes it if the commit does not have it. */
async function restorePath(repoRoot, root, commit, path) {
  const target = inside(root, path);
  let content;
  try { content = await git(repoRoot, ["show", `${commit}:${path}`], { buffer: true }); }
  catch { await rm(target, { force: true }); return "removed"; }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return "written";
}

/**
 * A detached worktree of `baseCommit` in a temp directory. `cleanup` is
 * idempotent and never throws, so callers can put it in `finally`.
 */
export async function createWorkspace({ repoRoot, baseCommit }) {
  const parent = await mkdtemp(join(tmpdir(), "atlas-eval-"));
  const root = join(parent, "ws");
  try { await git(repoRoot, ["worktree", "add", "--detach", root, baseCommit]); }
  catch (error) { await rm(parent, { recursive: true, force: true }); throw error; }
  let cleaned = false;
  return {
    root,
    async applyPaths(commit, paths) { for (const path of paths) await restorePath(repoRoot, root, commit, path); },
    async writeFiles(files) {
      for (const [path, content] of Object.entries(files)) {
        const target = inside(root, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    },
    /** Net file changes against prepared setup, including agent commits. */
    async changedPaths(baseline = "HEAD") {
      const tracked = await git(root, ["diff", "--name-only", "--no-renames", "-z", baseline, "--"]);
      const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
      return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { await git(repoRoot, ["worktree", "remove", "--force", root]); } catch { /* removed below */ }
      try { await git(repoRoot, ["worktree", "prune"]); } catch { /* best effort */ }
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** Applies recorded paths onto an existing directory (used by the gold agent). */
export function createWorkspaceView(repoRoot, root) {
  return {
    async applyPaths(commit, paths) { for (const path of paths) await restorePath(repoRoot, root, commit, path); },
    async writeFiles(files) {
      for (const [path, content] of Object.entries(files)) {
        const target = inside(root, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    },
  };
}
