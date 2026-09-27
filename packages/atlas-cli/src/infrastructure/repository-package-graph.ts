import { posix } from "node:path";
import { GitClient } from "./git-client.js";
import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import { nodeRepositoryFileSystem, type RepositoryFileSystem } from "./repository-file-system.js";

/**
 * The packages a repository is made of and how they depend on each other
 * (docs/PROGRAM.md 2.3: package graph; TODO.md: monorepo package discovery,
 * dependency extraction without executing package managers).
 *
 * Reads manifests only: package.json (npm, pnpm, yarn, bun) and
 * pyproject.toml (PEP 621 `[project]` and Poetry). No package manager, no
 * network, no lockfile resolution. Every dependency names the manifest and
 * the field it came from, and a dependency on another package in the same
 * repository is linked to that package's directory.
 */

export type PackageEcosystem = "npm" | "python";
export type DependencyKind = "runtime" | "dev" | "peer" | "optional";

export interface PackageDependency {
  readonly name: string;
  /** The version range or requirement as written ("^1.2.0", "workspace:*", ">=2"). */
  readonly range: string;
  readonly kind: DependencyKind;
  /** Directory of the package in this repository it refers to, when it is one. */
  readonly internal: string | null;
  /** Manifest field it was read from, e.g. "devDependencies" or "project.optional-dependencies.test". */
  readonly field: string;
}

export interface RepositoryPackage {
  /** Repository-relative directory ("." for the root). */
  readonly directory: string;
  readonly manifest: string;
  readonly ecosystem: PackageEcosystem;
  readonly name: string | null;
  readonly version: string | null;
  readonly private: boolean;
  /** Workspace globs this package declares for its children (npm/yarn/pnpm). */
  readonly workspaces: readonly string[];
  readonly scripts: readonly string[];
  /** Entry points as written in the manifest: exports ".", main, module, types, bin. */
  readonly entries: readonly { readonly field: string; readonly path: string }[];
  readonly dependencies: readonly PackageDependency[];
}

export interface PackageGraph {
  readonly packages: readonly RepositoryPackage[];
  /** Internal dependency edges: `from` depends on `to` (both directories). */
  readonly edges: readonly { readonly from: string; readonly to: string; readonly name: string; readonly kind: DependencyKind }[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

const MANIFESTS = new Set(["package.json", "pyproject.toml", "pnpm-workspace.yaml"]);
const DEFAULTS = { maxFiles: 20_000, maxDepth: 25, maxManifestBytes: 1024 * 1024 };
const NPM_FIELDS: readonly (readonly [string, DependencyKind])[] = [
  ["dependencies", "runtime"],
  ["devDependencies", "dev"],
  ["peerDependencies", "peer"],
  ["optionalDependencies", "optional"],
];

export class RepositoryPackageGraph {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async build(repositoryPath: string, options: Partial<typeof DEFAULTS> = {}): Promise<PackageGraph> {
    const limits = { ...DEFAULTS, ...options };
    const enumeration = await new RepositoryFileEnumerator(this.gitClient, this.fileSystem).enumerate(repositoryPath, {
      maxFiles: limits.maxFiles,
      maxDepth: limits.maxDepth,
      include: (path) => MANIFESTS.has(posix.basename(path.replaceAll("\\", "/"))),
    });
    const warnings: { code: string; message: string }[] = [...enumeration.warnings];
    const drafts: RepositoryPackage[] = [];
    const pnpmWorkspaces = new Map<string, string[]>();
    for (const file of [...enumeration.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      const manifest = file.relativePath.replaceAll("\\", "/");
      if (file.size > limits.maxManifestBytes) {
        warnings.push({ code: "MANIFEST_TOO_LARGE", message: `Skipped ${manifest}: larger than ${limits.maxManifestBytes} bytes.` });
        continue;
      }
      let text: string;
      try {
        text = (await this.fileSystem.readFile(file.absolutePath)).toString("utf8");
      } catch {
        warnings.push({ code: "PATH_UNREADABLE", message: `Could not read repository path: ${manifest}` });
        continue;
      }
      const directory = posix.dirname(manifest);
      const base = posix.basename(manifest);
      if (base === "pnpm-workspace.yaml") {
        pnpmWorkspaces.set(directory, pnpmPackages(text));
        continue;
      }
      const parsed = base === "package.json" ? npmPackage(directory, manifest, text) : pythonPackage(directory, manifest, text);
      if (parsed === null) {
        warnings.push({ code: "MANIFEST_UNPARSEABLE", message: `Could not parse ${manifest}; it is left out of the package graph.` });
        continue;
      }
      if (parsed !== "not-a-package") drafts.push(parsed);
    }

    // pnpm declares workspaces outside package.json.
    const withWorkspaces = drafts.map((item) => {
      const pnpm = item.ecosystem === "npm" ? pnpmWorkspaces.get(item.directory) : undefined;
      return pnpm && pnpm.length > 0 ? { ...item, workspaces: [...new Set([...item.workspaces, ...pnpm])] } : item;
    });

    // Link dependencies on packages that live in this repository. Names are
    // matched within an ecosystem; Python names compare normalized (PEP 503).
    const byName = new Map<string, string>();
    for (const item of withWorkspaces) {
      if (item.name === null) continue;
      const key = `${item.ecosystem}:${item.ecosystem === "python" ? normalizePythonName(item.name) : item.name}`;
      if (byName.has(key) && byName.get(key) !== item.directory) {
        warnings.push({ code: "DUPLICATE_PACKAGE_NAME", message: `${item.name} is declared in both ${byName.get(key)} and ${item.directory}; links use the first.` });
        continue;
      }
      byName.set(key, item.directory);
    }
    const packages = [...withWorkspaces].sort((a, b) => a.directory.localeCompare(b.directory) || a.ecosystem.localeCompare(b.ecosystem)).map((item) => ({
      ...item,
      dependencies: item.dependencies.map((dependency) => {
        const key = `${item.ecosystem}:${item.ecosystem === "python" ? normalizePythonName(dependency.name) : dependency.name}`;
        const target = byName.get(key) ?? localPathTarget(item.directory, dependency.range, withWorkspaces);
        return target !== undefined && target !== null && target !== item.directory ? { ...dependency, internal: target } : dependency;
      }),
    }));
    const edges = packages.flatMap((item) => item.dependencies
      .filter((dependency) => dependency.internal !== null)
      .map((dependency) => ({ from: item.directory, to: dependency.internal!, name: dependency.name, kind: dependency.kind })));
    if (enumeration.limitReached) warnings.push({ code: "FILE_LIMIT_REACHED", message: `Package discovery stopped after ${limits.maxFiles} files.` });
    return { packages, edges, warnings };
  }
}

/** "file:../x" / "link:../x" ranges point at a directory rather than a name. */
function localPathTarget(from: string, range: string, packages: readonly RepositoryPackage[]): string | null {
  const match = /^(?:file|link|portal):(.+)$/u.exec(range);
  if (!match?.[1]) return null;
  const directory = posix.normalize(posix.join(from, match[1])).replace(/\/$/u, "");
  return packages.some((item) => item.directory === directory) ? directory : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function npmPackage(directory: string, manifest: string, text: string): RepositoryPackage | null {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = record(JSON.parse(text));
  } catch {
    return null;
  }
  if (parsed === null) return null;
  const dependencies: PackageDependency[] = [];
  for (const [field, kind] of NPM_FIELDS) {
    for (const [name, range] of Object.entries(record(parsed[field]) ?? {})) {
      if (typeof range === "string") dependencies.push({ name, range, kind, internal: null, field });
    }
  }
  const workspacesValue = parsed["workspaces"];
  const workspaceList = Array.isArray(workspacesValue) ? workspacesValue : record(workspacesValue)?.["packages"];
  const entries: { field: string; path: string }[] = [];
  const exportsValue = parsed["exports"];
  const root = typeof exportsValue === "string" ? exportsValue : record(exportsValue)?.["."] ?? (record(exportsValue) && !Object.keys(record(exportsValue)!).some((key) => key.startsWith(".")) ? exportsValue : undefined);
  for (const path of exportTargets(root)) entries.push({ field: "exports", path });
  for (const field of ["main", "module", "types", "typings", "source"]) {
    const value = parsed[field];
    if (typeof value === "string") entries.push({ field, path: value });
  }
  const bin = parsed["bin"];
  if (typeof bin === "string") entries.push({ field: "bin", path: bin });
  for (const [name, path] of Object.entries(record(bin) ?? {})) if (typeof path === "string") entries.push({ field: `bin.${name}`, path });
  return {
    directory,
    manifest,
    ecosystem: "npm",
    name: typeof parsed["name"] === "string" ? parsed["name"] : null,
    version: typeof parsed["version"] === "string" ? parsed["version"] : null,
    private: parsed["private"] === true,
    workspaces: Array.isArray(workspaceList) ? workspaceList.filter((item): item is string => typeof item === "string") : [],
    scripts: Object.keys(record(parsed["scripts"]) ?? {}),
    entries: dedupeEntries(entries),
    dependencies,
  };
}

/** Condition values of an `exports["."]` entry, most source-like first. */
function exportTargets(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => exportTargets(item, depth + 1));
  const conditions = record(value);
  if (!conditions || depth > 4) return [];
  const order = ["source", "development", "import", "module", "default", "require", "node", "types"];
  const keys = [...Object.keys(conditions)].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return keys.flatMap((key) => exportTargets(conditions[key], depth + 1));
}

function dedupeEntries(entries: readonly { field: string; path: string }[]): { field: string; path: string }[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.field}\0${entry.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Minimal pnpm-workspace.yaml reader: the `packages:` list, block or flow form. */
function pnpmPackages(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^packages\s*:/u.test(line));
  if (start === -1) return [];
  const unquote = (value: string) => value.split(" #")[0]!.trim().replace(/^["']|["']$/gu, "");
  const flow = /^packages\s*:\s*\[(.*)\]/u.exec(lines[start]!);
  if (flow) return flow[1]!.split(",").map(unquote).filter(Boolean);
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    const item = /^\s*-\s*(.+)$/u.exec(line);
    if (item?.[1]) found.push(unquote(item[1]));
  }
  return found.filter(Boolean);
}

// --- pyproject.toml: just the tables that name a package and its requirements.

type TomlValue = string | boolean | number | readonly TomlValue[] | { readonly [key: string]: TomlValue };

/**
 * A bounded TOML subset: [tables], key = string / literal string / boolean /
 * number / (multi-line) array of those / inline table. Enough for PEP 621
 * and Poetry metadata; anything else on a line is skipped, not guessed at.
 */
export function parseTomlSubset(text: string): Map<string, Record<string, TomlValue>> {
  const tables = new Map<string, Record<string, TomlValue>>([["", {}]]);
  let current = tables.get("")!;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    let line = stripTomlComment(lines[index]!).trim();
    if (line.length === 0) continue;
    const header = /^\[\s*([^\[\]]+?)\s*\]$/u.exec(line);
    if (header) {
      const name = header[1]!.split(".").map((part) => part.trim().replace(/^["']|["']$/gu, "")).join(".");
      current = tables.get(name) ?? {};
      tables.set(name, current);
      continue;
    }
    if (/^\[\[/u.test(line)) { current = {}; continue; }
    const assignment = /^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.*)$/u.exec(line);
    if (!assignment) continue;
    // Arrays and inline tables may span lines: gather until brackets balance.
    let value = assignment[2]!;
    while (!balanced(value) && index + 1 < lines.length) {
      index += 1;
      value += `\n${stripTomlComment(lines[index]!)}`;
    }
    line = value.trim();
    const parsed = parseTomlValue(line);
    if (parsed !== undefined) current[assignment[1]!.replace(/^["']|["']$/gu, "")] = parsed;
  }
  return tables;
}

function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === "\\" && quote === "\"") index += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function balanced(value: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === "\\" && quote === "\"") index += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
  }
  return depth <= 0;
}

function parseTomlValue(raw: string): TomlValue | undefined {
  const text = raw.trim();
  if (text.startsWith("\"\"\"") || text.startsWith("'''")) return undefined;
  if (text.startsWith("\"")) {
    const match = /^"((?:[^"\\]|\\.)*)"/u.exec(text);
    return match ? match[1]!.replace(/\\(["\\])/gu, "$1") : undefined;
  }
  if (text.startsWith("'")) {
    const match = /^'([^']*)'/u.exec(text);
    return match ? match[1]! : undefined;
  }
  if (text === "true" || text === "false") return text === "true";
  if (/^[+-]?\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  if (text.startsWith("[")) {
    const items = splitTopLevel(text.slice(1, text.lastIndexOf("]")));
    return items.map(parseTomlValue).filter((item): item is TomlValue => item !== undefined);
  }
  if (text.startsWith("{")) {
    const entries: Record<string, TomlValue> = {};
    for (const part of splitTopLevel(text.slice(1, text.lastIndexOf("}")))) {
      const pair = /^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*([\s\S]*)$/u.exec(part.trim());
      const value = pair ? parseTomlValue(pair[2]!) : undefined;
      if (pair && value !== undefined) entries[pair[1]!.replace(/^["']|["']$/gu, "")] = value;
    }
    return entries;
  }
  return undefined;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote) {
      if (char === "\\" && quote === "\"") index += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}

/** Name and requirement from a PEP 508 string ("requests[socks]>=2 ; python_version>'3.8'"). */
function pep508(requirement: string): { name: string; range: string } | null {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/u.exec(requirement);
  if (!match?.[1]) return null;
  return { name: match[1], range: match[2]!.trim() || "*" };
}

function pythonPackage(directory: string, manifest: string, text: string): RepositoryPackage | "not-a-package" | null {
  let tables: Map<string, Record<string, TomlValue>>;
  try {
    tables = parseTomlSubset(text);
  } catch {
    return null;
  }
  const project = tables.get("project");
  const poetry = tables.get("tool.poetry");
  if (!project && !poetry) return "not-a-package";
  const dependencies: PackageDependency[] = [];
  const add = (requirement: TomlValue, kind: DependencyKind, field: string) => {
    if (typeof requirement !== "string") return;
    const parsed = pep508(requirement);
    if (parsed) dependencies.push({ ...parsed, kind, internal: null, field });
  };
  if (project) {
    for (const requirement of Array.isArray(project["dependencies"]) ? project["dependencies"] : []) add(requirement, "runtime", "project.dependencies");
    for (const [group, list] of Object.entries(tables.get("project.optional-dependencies") ?? {})) {
      for (const requirement of Array.isArray(list) ? list : []) add(requirement, "optional", `project.optional-dependencies.${group}`);
    }
  }
  for (const [group, list] of Object.entries(tables.get("dependency-groups") ?? {})) {
    for (const requirement of Array.isArray(list) ? list : []) add(requirement, "dev", `dependency-groups.${group}`);
  }
  const poetryTable = (name: string, kind: DependencyKind, field: string) => {
    for (const [dependency, spec] of Object.entries(tables.get(name) ?? {})) {
      if (dependency === "python") continue;
      const range = typeof spec === "string" ? spec : typeof spec === "object" && !Array.isArray(spec) && typeof (spec as Record<string, TomlValue>)["version"] === "string" ? (spec as Record<string, TomlValue>)["version"] as string
        : typeof spec === "object" && !Array.isArray(spec) && typeof (spec as Record<string, TomlValue>)["path"] === "string" ? `file:${(spec as Record<string, TomlValue>)["path"] as string}` : "*";
      dependencies.push({ name: dependency, range, kind, internal: null, field });
    }
  };
  poetryTable("tool.poetry.dependencies", "runtime", "tool.poetry.dependencies");
  poetryTable("tool.poetry.dev-dependencies", "dev", "tool.poetry.dev-dependencies");
  for (const name of [...tables.keys()]) {
    const group = /^tool\.poetry\.group\.([^.]+)\.dependencies$/u.exec(name);
    if (group) poetryTable(name, "dev", name);
  }
  // [project.scripts] is its own table; an inline `scripts = {...}` works too.
  const scripts = {
    ...(record(project?.["scripts"]) ?? {}), ...(tables.get("project.scripts") ?? {}),
    ...(record(poetry?.["scripts"]) ?? {}), ...(tables.get("tool.poetry.scripts") ?? {}),
  } as Record<string, TomlValue>;
  const nameValue = project?.["name"] ?? poetry?.["name"];
  const versionValue = project?.["version"] ?? poetry?.["version"];
  return {
    directory,
    manifest,
    ecosystem: "python",
    name: typeof nameValue === "string" ? nameValue : null,
    version: typeof versionValue === "string" ? versionValue : null,
    private: false,
    workspaces: [],
    scripts: Object.keys(scripts),
    entries: Object.entries(scripts).filter(([, target]) => typeof target === "string").map(([name, target]) => ({ field: `scripts.${name}`, path: target as string })),
    dependencies,
  };
}
