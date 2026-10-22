import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_BYTES = 2 * 1024 * 1024;

/** Checkpoints are evidence of partial work, never a completed result to replay. */
export function readCoderProgress(filename) {
  try {
    if (!fs.lstatSync(filename).isFile() || fs.statSync(filename).size > MAX_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    return value?.schemaVersion === 1 && Array.isArray(value.edits) ? value : null;
  } catch { return null; }
}

/** Trusted runner capture; the caller MUST redact this before storing an artifact. */
export function captureCoderRecovery(repositoryRoot, baseCommit, edits = []) {
  const root = fs.realpathSync(repositoryRoot);
  const diff = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", baseCommit, "--"], {
    cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: MAX_BYTES, windowsHide: true,
  });
  const untracked = [];
  const withheld = [];
  const capturedPaths = new Set();
  let bytes = Buffer.byteLength(diff.stdout ?? "");
  for (const edit of edits.slice(0, 256)) {
    if (!edit || typeof edit.path !== "string" || !["create", "rename"].includes(edit.operation)) continue;
    const relative = edit.path.replaceAll("\\", "/");
    if (path.isAbsolute(relative) || relative.split("/").some(part => ["..", ".git"].includes(part))) continue;
    if (capturedPaths.has(relative)) continue;
    capturedPaths.add(relative);
    const target = path.resolve(root, relative);
    try {
      const actual = fs.realpathSync(target);
      if (actual !== target || !actual.startsWith(root + path.sep) || !fs.lstatSync(target).isFile()) continue;
      const size = fs.statSync(target).size;
      if (size > MAX_BYTES - bytes) { withheld.push(relative); continue; }
      const content = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(target));
      if (content.includes("\0")) { withheld.push(relative); continue; }
      untracked.push({ path: relative, content });
      bytes += size;
    } catch { withheld.push(relative); }
  }
  return {
    schemaVersion: 1, baseCommit, completionConfirmed: false,
    trackedDiff: diff.status === 0 ? diff.stdout : null,
    captureError: diff.status === 0 ? null : "Tracked diff could not be fully captured within its size/time bound.",
    untracked, withheld,
    continuation: "Review these changes against baseCommit, restore them in an isolated checkout, and rerun validation before continuing. Completed tools must not be replayed blindly.",
  };
}
