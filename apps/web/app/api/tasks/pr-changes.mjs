/**
 * The files a coder run changed, shaped for the chat: one entry per file with
 * its status, line counts and unified-diff patch, the way a coding agent shows
 * its edits. Patches are capped per file and in total so a huge refactor
 * cannot flood the browser; a capped patch says so.
 */

const MAX_FILES = 100;
const MAX_PATCH_CHARS = 20_000;
const MAX_TOTAL_CHARS = 200_000;
const STATUSES = new Set(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);

/**
 * @param {unknown} payload GitHub's `GET /repos/{r}/pulls/{n}/files` response
 * @returns {{ files: { path: string, previousPath: string|null, status: string, additions: number, deletions: number, patch: string|null, truncated: boolean }[], additions: number, deletions: number }}
 */
export function changedFilesFrom(payload) {
  const files = [];
  let budget = MAX_TOTAL_CHARS;
  let additions = 0;
  let deletions = 0;
  for (const entry of Array.isArray(payload) ? payload.slice(0, MAX_FILES) : []) {
    if (typeof entry?.filename !== "string") continue;
    const added = Number.isInteger(entry.additions) ? entry.additions : 0;
    const removed = Number.isInteger(entry.deletions) ? entry.deletions : 0;
    additions += added;
    deletions += removed;
    const raw = typeof entry.patch === "string" ? entry.patch : null;
    const allowed = Math.max(0, Math.min(MAX_PATCH_CHARS, budget));
    const patch = raw === null ? null : raw.slice(0, allowed);
    budget -= patch?.length ?? 0;
    files.push({
      path: entry.filename,
      previousPath: typeof entry.previous_filename === "string" ? entry.previous_filename : null,
      status: STATUSES.has(entry.status) ? entry.status : "modified",
      additions: added,
      deletions: removed,
      patch,
      truncated: raw !== null && patch.length < raw.length,
    });
  }
  return { files, additions, deletions };
}
