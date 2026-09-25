import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Repository signals: deterministic, citable evidence the Business
 * Development Executive can attach to an Opportunity Brief when Atlas looks
 * at a repository — including its own. Every signal names the file and line
 * it came from, so a reviewer can check it rather than trust a summary.
 *
 * This collector only reads. It lists tracked files through git (no shell),
 * skips anything large or binary, and stops at fixed bounds.
 */

const MARKER = /\b(TODO|FIXME|HACK|XXX|BUG)\b[:\s(-]+(.{0,200})/u;
const TEXT_EXTENSIONS = /\.(m?[jt]sx?|cjs|py|rs|go|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|sql|ya?ml|toml|md|sh|ps1)$/iu;
const SKIP_PATH = /(^|\/)(node_modules|dist|build|vendor|\.git|coverage|\.next)\//u;

export const SIGNAL_LIMITS = Object.freeze({ maxFiles: 5000, maxFileBytes: 512 * 1024, maxSignals: 200 });

function trackedFiles(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * @param {string} repositoryRoot absolute path to a git working tree
 * @returns {{ root: string, filesScanned: number, truncated: boolean, signals: Array<{kind, marker, path, line, text}>, evidence: Array }}
 */
export function collectRepositorySignals(repositoryRoot, limits = {}) {
  const { maxFiles, maxFileBytes, maxSignals } = { ...SIGNAL_LIMITS, ...limits };
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) throw new TypeError("repositoryRoot must be an absolute path.");
  const root = resolve(repositoryRoot);
  const files = trackedFiles(root);
  if (!files) throw Object.assign(new Error("The path is not a readable git working tree."), { code: "NOT_A_REPOSITORY" });
  const signals = [];
  let filesScanned = 0;
  let truncated = false;
  for (const path of files) {
    if (SKIP_PATH.test(path) || !TEXT_EXTENSIONS.test(path)) continue;
    if (filesScanned >= maxFiles) { truncated = true; break; }
    const absolute = join(root, path);
    if (relative(root, absolute).startsWith("..")) continue;
    let content;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile() || stat.size > maxFileBytes) continue;
      content = readFileSync(absolute, "utf8");
    } catch { continue; }
    filesScanned += 1;
    const lines = content.split(/\r?\n/u);
    for (let i = 0; i < lines.length; i += 1) {
      const match = MARKER.exec(lines[i]);
      if (!match) continue;
      signals.push({ kind: "code_marker", marker: match[1], path, line: i + 1, text: match[2].trim() });
      if (signals.length >= maxSignals) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return {
    root,
    filesScanned,
    truncated,
    signals,
    // Shaped as Opportunity Brief evidence; the BDE still decides whether any of it matters.
    evidence: signals.map((s) => ({
      kind: "repository_signal",
      summary: `${s.marker}: ${s.text || "(no description)"}`,
      source: `${s.path}:${s.line}`,
      strength: s.marker === "FIXME" || s.marker === "BUG" ? "moderate" : "weak",
    })),
  };
}
