#!/usr/bin/env node
/**
 * Runs inside an Atlas cloud sandbox (copied into the image as
 * /opt/atlas/tree-manifest.mjs) and prints the workspace's tree as JSON:
 *
 *   { "entries": [{ "mode": "100644", "path": "src/app.mjs", "sha256": "<hex>" }, ...] }
 *
 * The entries are exactly what a local snapshot's commit would hold
 * (apps/local-control/src/platform/environments/local.mjs → treeDigest):
 * - in a git workspace, every path git would commit after `git add -A`
 *   (tracked and untracked, minus ignored files; paths deleted from disk are
 *   left out), with git's mode for it;
 * - elsewhere, every file and symlink under the directory except `.git/`.
 * The digest content is the file's bytes, `symlink <target>` for a symlink
 * and `submodule <oid>` for a gitlink. The caller (the local
 * CloudflareSandboxEnvironment) turns the entries into the tree digest with
 * the same function a local snapshot uses, so a snapshot verifies the same
 * way in either place.
 *
 * No dependencies beyond Node and git, and argv only: nothing is run through a shell.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function gitPaths(dir) {
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "buffer", maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }).toString("utf8");
  const gitlinks = new Map();
  for (const line of git(["ls-files", "-z", "-s"]).split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const [mode, oid] = line.slice(0, tab).split(" ");
    if (mode === "160000") gitlinks.set(line.slice(tab + 1), oid);
  }
  const paths = [...new Set(git(["ls-files", "-z", "-co", "--exclude-standard"]).split("\0").filter(Boolean))];
  return { paths, gitlinks };
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (dir === base && entry.name === ".git") continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, base, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(base, absolute).split(sep).join("/"));
  }
  return out;
}

function isGitWorkspace(dir) {
  try { return lstatSync(join(dir, ".git")).isDirectory(); } catch { return false; }
}

export function treeEntries(dir) {
  const { paths, gitlinks } = isGitWorkspace(dir) ? gitPaths(dir) : { paths: walk(dir), gitlinks: new Map() };
  const entries = [];
  for (const path of paths) {
    if (gitlinks.has(path)) { entries.push({ mode: "160000", path, sha256: sha256(`submodule ${gitlinks.get(path)}`) }); continue; }
    let stat;
    try { stat = lstatSync(join(dir, path)); } catch { continue; } // deleted from disk: `git add -A` would drop it too
    if (stat.isSymbolicLink()) entries.push({ mode: "120000", path, sha256: sha256(`symlink ${readlinkSync(join(dir, path))}`) });
    else if (stat.isFile()) entries.push({ mode: stat.mode & 0o111 ? "100755" : "100644", path, sha256: sha256(readFileSync(join(dir, path))) });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write("usage: tree-manifest.mjs <directory>\n"); process.exit(2); }
  process.stdout.write(JSON.stringify({ entries: treeEntries(dir) }));
}
