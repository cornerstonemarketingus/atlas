import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

/**
 * World graph (ROADMAP Track B2): a repository's structure as typed entities
 * and relations in the world state, so the kernel can answer "what breaks if
 * I change this?" across files and packages.
 *
 *   repository ← part_of ← package ← part_of ← file
 *   package -depends_on-> package       (a local package dependency)
 *   file -depends_on-> file | package   (an import)
 *   test file -tests-> file             (an import from a test)
 *
 * Files use the same keys coder runs already record (`<repository>:<path>`),
 * so what a run touched joins the map. A re-map replaces only the edges the
 * previous map of the same repository recorded.
 */

const SOURCE_EXTENSIONS = [".mjs", ".js", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".jsx"];
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", ".cache", "vendor", "out", ".wrangler"]);
const IMPORT = /(?:\bimport\s+(?:[^'"`;]*?\sfrom\s+)?|\bexport\s+[^'"`;]*?\sfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"'\n]{1,300})["']/gu;
const MAX_FILE_BYTES = 512 * 1024;

export class RepoGraphError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RepoGraphError";
    this.code = code;
  }
}

/** True for test files by the usual conventions. */
export function isTestFile(path) {
  return /(?:^|\/)(?:tests?|__tests__|e2e)\//u.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
}

/** Module specifiers a source file imports (static, dynamic with a literal, re-exports, require). */
export function importsOf(text) {
  const found = new Set();
  for (const match of text.matchAll(IMPORT)) found.add(match[1]);
  return [...found];
}

/**
 * Maps a repository into the world state.
 * @returns {{ repository: string, packages: number, files: number, imports: number, truncated: boolean }}
 */
export function mapRepository(world, root, { maxFiles = 3000 } = {}) {
  let info;
  try { info = statSync(root); } catch { throw new RepoGraphError("NOT_FOUND", "That repository folder does not exist."); }
  if (!info.isDirectory()) throw new RepoGraphError("NOT_A_DIRECTORY", "A repository must be a folder.");

  const files = [];
  const manifests = [];
  let truncated = false;
  const walk = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) walk(full);
      } else if (entry.isFile()) {
        const path = relative(root, full).split(sep).join("/");
        if (entry.name === "package.json") manifests.push(path);
        else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) && !entry.name.endsWith(".d.ts")) files.push(path);
      }
    }
  };
  walk(root);

  const packages = [];
  for (const manifest of manifests) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, manifest), "utf8"));
      const directory = posix.dirname(manifest);
      const dependencies = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies, ...parsed.peerDependencies, ...parsed.optionalDependencies });
      packages.push({ directory: directory === "." ? "" : directory, name: typeof parsed.name === "string" ? parsed.name : null, dependencies });
    } catch { /* an unreadable manifest is left out */ }
  }
  // Deepest first, so a file belongs to its nearest package.
  packages.sort((a, b) => b.directory.length - a.directory.length);
  const byName = new Map(packages.filter((entry) => entry.name).map((entry) => [entry.name, entry]));
  const packageKey = (entry) => `${root}:${entry.directory || "."}`;
  const owner = (path) => packages.find((entry) => !entry.directory || path === entry.directory || path.startsWith(`${entry.directory}/`)) ?? null;

  const source = `repo-map:${root}`;
  const repository = { type: "repository", key: root };
  const entities = [{ type: "repository", key: root, attrs: { name: root, mappedFiles: files.length, mappedPackages: packages.length } }];
  const relations = [];
  for (const entry of packages) {
    entities.push({ type: "package", key: packageKey(entry), attrs: { name: entry.name ?? (entry.directory || "."), path: entry.directory || ".", repository: root } });
    relations.push({ from: { type: "package", key: packageKey(entry) }, relation: "part_of", to: repository });
  }
  for (const entry of packages) {
    for (const dependency of entry.dependencies) {
      const local = byName.get(dependency);
      if (local && local !== entry) relations.push({ from: { type: "package", key: packageKey(entry) }, relation: "depends_on", to: { type: "package", key: packageKey(local) } });
    }
  }

  const known = new Set(files);
  let imports = 0;
  for (const path of files) {
    const test = isTestFile(path);
    const file = { type: "file", key: `${root}:${path}` };
    entities.push({ ...file, attrs: { path, repository: root, kind: test ? "test" : "source" } });
    const home = owner(path);
    relations.push({ from: file, relation: "part_of", to: home ? { type: "package", key: packageKey(home) } : repository });
    let text;
    try {
      if (statSync(join(root, path)).size > MAX_FILE_BYTES) continue;
      text = readFileSync(join(root, path), "utf8");
    } catch { continue; }
    for (const specifier of importsOf(text)) {
      const target = specifier.startsWith(".") ? resolveRelative(path, specifier, known) : resolvePackage(specifier, byName);
      if (!target) continue;
      const to = typeof target === "string" ? { type: "file", key: `${root}:${target}` } : { type: "package", key: packageKey(target) };
      if (typeof target !== "string" && target === home) continue;
      relations.push({ from: file, relation: test && typeof target === "string" ? "tests" : "depends_on", to });
      imports += 1;
    }
  }

  world.dropRelations({ source });
  world.apply({ source, entities, relations });
  return { repository: root, packages: packages.length, files: files.length, imports, truncated };
}

function resolveRelative(from, specifier, known) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stripped = base.replace(/\.[cm]?js$/u, "");
  const candidates = [base, ...SOURCE_EXTENSIONS.map((extension) => `${stripped}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`)];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

function resolvePackage(specifier, byName) {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return byName.get(name) ?? null;
}
