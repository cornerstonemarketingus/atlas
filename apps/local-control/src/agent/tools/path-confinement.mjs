import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Confines a path to a root, through symlinks.
 *
 * `path.resolve()` normalizes lexically: it collapses `..` and makes a path
 * absolute, but it does not follow symlinks. That makes the obvious
 * confinement check — resolve, then compare the prefix — wrong. A symlink
 * inside the root pointing outside it passes the check and then reads or
 * writes wherever it points.
 *
 * This is not a hypothetical: repositories legitimately contain symlinks, the
 * agent clones repositories it was pointed at, and the model chooses the paths.
 * So the real path is resolved before the comparison.
 *
 * A path that does not exist yet (the target of a write) has no real path, so
 * the deepest ancestor that *does* exist is resolved and the remaining
 * segments are appended. That closes the case where the final component is a
 * dangling symlink or a new file inside a symlinked directory.
 *
 * Residual risk, stated rather than hidden: this is a check-then-use, so a
 * symlink swapped between the check and the open would still win. Closing
 * that needs O_NOFOLLOW on every open. For a single-operator daemon whose
 * attacker is the model's own path choices rather than a local hostile
 * process, resolving the link is the boundary that matters.
 */
export function confineRealPath(root, candidate, makeError) {
  if (!root) throw makeError("NO_ROOT", "No root directory is configured for this operation.");

  // The root itself may be a symlink — a profile directory under a symlinked
  // home, for instance — so it is resolved too, or every path under it would
  // look like an escape.
  const realRoot = realpathOf(resolve(root));
  const target = resolve(realRoot, candidate ?? ".");
  const real = realpathOf(target);

  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw makeError("PATH_ESCAPES_ROOT", `'${candidate}' resolves outside the permitted directory.`);
  }
  return real;
}

/**
 * The real path of `target`, or — when it does not exist yet — the real path
 * of its deepest existing ancestor with the missing segments appended.
 */
function realpathOf(target) {
  const missing = [];
  let current = target;
  for (;;) {
    try {
      const resolved = realpathSync(current);
      return missing.length === 0 ? resolved : join(resolved, ...missing);
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return target;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}
