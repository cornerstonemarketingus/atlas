import { join } from "node:path";
import type {
  ManifestDependency,
  RepositoryManifest,
  RepositoryManifestSummary,
} from "../domain/repository-manifest.js";
import type { InspectionWarning } from "../domain/repository-summary.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

type TomlValue = string | string[];
type TomlTable = Map<string, TomlValue>;
type TomlDocument = Map<string, TomlTable>;

function byName(left: ManifestDependency, right: ManifestDependency): number {
  return left.name.localeCompare(right.name);
}

function objectToDependencies(value: unknown): ManifestDependency[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const dependencies: ManifestDependency[] = [];
  for (const [name, versionRange] of Object.entries(value)) {
    dependencies.push({
      name,
      versionRange: typeof versionRange === "string" ? versionRange : null,
    });
  }
  return dependencies.sort(byName);
}

/**
 * A small, bounded, defensive parser for the subset of TOML that manifest
 * files in this reader rely on: flat `key = "value"` assignments,
 * `[section]` / `[section.sub]` headers, and simple (optionally multi-line)
 * `["a", "b"]` string arrays. It never throws — anything it cannot make
 * sense of is simply skipped, and the caller treats a missing/empty result
 * as "could not parse".
 */
function parseBoundedToml(content: string): TomlDocument {
  const document: TomlDocument = new Map();
  const ensureSection = (name: string): TomlTable => {
    const existing = document.get(name);
    if (existing !== undefined) return existing;
    const created: TomlTable = new Map();
    document.set(name, created);
    return created;
  };

  let currentSection = ensureSection("");
  let pendingKey: string | null = null;
  let pendingArrayRaw = "";

  const lines = content.split(/\r?\n/);
  const maxLines = Math.min(lines.length, 50_000);

  for (let index = 0; index < maxLines; index += 1) {
    const rawLine = lines[index] ?? "";
    if (pendingKey !== null) {
      const chunk = stripTomlComment(rawLine);
      pendingArrayRaw += `\n${chunk}`;
      if (chunk.includes("]")) {
        currentSection.set(pendingKey, extractStringArray(pendingArrayRaw));
        pendingKey = null;
        pendingArrayRaw = "";
      }
      continue;
    }

    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;

    const sectionMatch = /^\[([^[\]]+)]$/.exec(line);
    if (sectionMatch !== null) {
      currentSection = ensureSection((sectionMatch[1] ?? "").trim());
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = unquote(line.slice(0, equalsIndex).trim());
    const valuePart = line.slice(equalsIndex + 1).trim();
    if (key.length === 0) continue;

    if (valuePart.startsWith("[")) {
      if (valuePart.includes("]")) {
        currentSection.set(key, extractStringArray(valuePart));
      } else {
        pendingKey = key;
        pendingArrayRaw = valuePart;
      }
      continue;
    }

    currentSection.set(key, unquote(valuePart));
  }

  return document;
}

function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function extractStringArray(raw: string): string[] {
  const values: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    values.push(match[1] ?? match[2] ?? "");
  }
  return values;
}

function getTomlString(table: TomlTable, key: string): string | null {
  const value = table.get(key);
  return typeof value === "string" ? value : null;
}

function getTomlStringArray(table: TomlTable, key: string): readonly string[] {
  const value = table.get(key);
  return Array.isArray(value) ? value : [];
}

function resolveDependencyValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("{")) {
    const match = /version\s*=\s*"([^"]*)"/.exec(trimmed);
    return match?.[1] ?? null;
  }
  return trimmed;
}

function tomlTableToDependencies(
  table: TomlTable | undefined,
  exclude: ReadonlySet<string> = new Set(),
): ManifestDependency[] {
  if (table === undefined) return [];
  const dependencies: ManifestDependency[] = [];
  for (const [name, value] of table) {
    if (exclude.has(name)) continue;
    const raw = typeof value === "string" ? value : null;
    dependencies.push({ name, versionRange: raw === null ? null : resolveDependencyValue(raw) });
  }
  return dependencies.sort(byName);
}

const PEP508_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*])?\s*(.*)$/;

function splitPep508(spec: string): ManifestDependency {
  const withoutMarker = (spec.split(";")[0] ?? spec).trim();
  const match = PEP508_PATTERN.exec(withoutMarker);
  if (match === null) return { name: withoutMarker, versionRange: null };
  const name = match[1] ?? withoutMarker;
  const rest = (match[3] ?? "").trim();
  return { name, versionRange: rest.length > 0 ? rest : null };
}

function parseRequirementsTxt(content: string): ManifestDependency[] {
  const dependencies: ManifestDependency[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("-")) continue;
    const hashIndex = line.indexOf(" #");
    if (hashIndex !== -1) line = line.slice(0, hashIndex).trim();
    if (line.length === 0) continue;
    dependencies.push(splitPep508(line));
  }
  return dependencies.sort(byName);
}

function stripGoComment(line: string): string {
  const index = line.indexOf("//");
  return index === -1 ? line : line.slice(0, index);
}

function parseGoRequireEntry(entry: string): ManifestDependency | null {
  const parts = entry.split(/\s+/).filter((part) => part.length > 0);
  const modulePath = parts[0];
  if (modulePath === undefined || modulePath.length === 0) return null;
  const version = parts[1];
  return { name: modulePath, versionRange: version !== undefined && version.length > 0 ? version : null };
}

function parseGoMod(content: string): { name: string | null; dependencies: ManifestDependency[] } {
  let name: string | null = null;
  const dependencies: ManifestDependency[] = [];
  let inRequireBlock = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripGoComment(rawLine).trim();
    if (line.length === 0) continue;

    if (inRequireBlock) {
      if (line === ")") {
        inRequireBlock = false;
        continue;
      }
      const dependency = parseGoRequireEntry(line);
      if (dependency !== null) dependencies.push(dependency);
      continue;
    }

    if (line.startsWith("module ")) {
      const modulePath = line.slice("module ".length).trim();
      name = modulePath.length > 0 ? modulePath : null;
      continue;
    }
    if (line === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (line.startsWith("require ")) {
      const dependency = parseGoRequireEntry(line.slice("require ".length).trim());
      if (dependency !== null) dependencies.push(dependency);
      continue;
    }
  }

  dependencies.sort(byName);
  return { name, dependencies };
}

export class RepositoryManifestReader {
  public constructor(
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async read(
    repositoryPath: string,
    warnings: InspectionWarning[] = [],
  ): Promise<RepositoryManifestSummary> {
    let root: string;
    try {
      root = await this.fileSystem.realPath(repositoryPath);
    } catch {
      warnings.push({
        code: "PATH_UNREADABLE",
        message: `Could not resolve repository path: ${repositoryPath}`,
      });
      return { schemaVersion: 1, manifests: [] };
    }

    const manifests: RepositoryManifest[] = [];
    const readers: Array<() => Promise<RepositoryManifest | null>> = [
      () => this.readPackageJson(root, warnings),
      () => this.readPyproject(root, warnings),
      () => this.readCargo(root, warnings),
      () => this.readGoMod(root, warnings),
      () => this.readRequirementsTxt(root, warnings),
    ];

    for (const readManifest of readers) {
      const manifest = await readManifest();
      if (manifest !== null) manifests.push(manifest);
    }

    manifests.sort((left, right) => left.path.localeCompare(right.path));
    return { schemaVersion: 1, manifests };
  }

  private async loadManifestFile(
    root: string,
    filename: string,
    warnings: InspectionWarning[],
  ): Promise<string | null> {
    const fullPath = join(root, filename);
    let linkStats;
    try {
      linkStats = await this.fileSystem.getLinkStats(fullPath);
    } catch {
      return null;
    }

    if (linkStats.isSymbolicLink()) {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: `Skipped symlinked manifest: ${filename}`,
      });
      return null;
    }
    if (!linkStats.isFile()) return null;
    if (linkStats.size > MAX_MANIFEST_BYTES) {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: `Skipped oversized manifest: ${filename}`,
      });
      return null;
    }

    try {
      const buffer = await this.fileSystem.readFile(fullPath);
      return buffer.toString("utf8");
    } catch {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: `Could not read manifest: ${filename}`,
      });
      return null;
    }
  }

  private async readPackageJson(
    root: string,
    warnings: InspectionWarning[],
  ): Promise<RepositoryManifest | null> {
    const content = await this.loadManifestFile(root, "package.json", warnings);
    if (content === null) return null;

    try {
      const parsed = JSON.parse(content) as {
        name?: unknown;
        version?: unknown;
        dependencies?: unknown;
        devDependencies?: unknown;
      };
      return {
        ecosystem: "npm",
        path: "package.json",
        name: typeof parsed.name === "string" ? parsed.name : null,
        version: typeof parsed.version === "string" ? parsed.version : null,
        dependencies: objectToDependencies(parsed.dependencies),
        devDependencies: objectToDependencies(parsed.devDependencies),
      };
    } catch {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: "Could not parse manifest: package.json",
      });
      return null;
    }
  }

  private async readPyproject(
    root: string,
    warnings: InspectionWarning[],
  ): Promise<RepositoryManifest | null> {
    const content = await this.loadManifestFile(root, "pyproject.toml", warnings);
    if (content === null) return null;

    try {
      const document = parseBoundedToml(content);

      const projectTable = document.get("project");
      if (projectTable !== undefined && projectTable.size > 0) {
        const dependencies = getTomlStringArray(projectTable, "dependencies")
          .map(splitPep508)
          .sort(byName);
        return {
          ecosystem: "python-pep621",
          path: "pyproject.toml",
          name: getTomlString(projectTable, "name"),
          version: getTomlString(projectTable, "version"),
          dependencies,
          devDependencies: [],
        };
      }

      const poetryTable = document.get("tool.poetry");
      if (poetryTable !== undefined && poetryTable.size > 0) {
        const dependencies = tomlTableToDependencies(
          document.get("tool.poetry.dependencies"),
          new Set(["python"]),
        );
        const devDependencies = tomlTableToDependencies(
          document.get("tool.poetry.dev-dependencies"),
        );
        return {
          ecosystem: "python-poetry",
          path: "pyproject.toml",
          name: getTomlString(poetryTable, "name"),
          version: getTomlString(poetryTable, "version"),
          dependencies,
          devDependencies,
        };
      }

      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: "pyproject.toml has neither a [project] nor a [tool.poetry] table",
      });
      return null;
    } catch {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: "Could not parse manifest: pyproject.toml",
      });
      return null;
    }
  }

  private async readCargo(
    root: string,
    warnings: InspectionWarning[],
  ): Promise<RepositoryManifest | null> {
    const content = await this.loadManifestFile(root, "Cargo.toml", warnings);
    if (content === null) return null;

    try {
      const document = parseBoundedToml(content);
      const packageTable = document.get("package");
      const dependencies = tomlTableToDependencies(document.get("dependencies"));
      const devDependencies = tomlTableToDependencies(document.get("dev-dependencies"));

      if (packageTable === undefined && dependencies.length === 0 && devDependencies.length === 0) {
        warnings.push({
          code: "MANIFEST_PARSE_FAILED",
          message: "Cargo.toml has no recognizable [package] or dependency tables",
        });
        return null;
      }

      return {
        ecosystem: "cargo",
        path: "Cargo.toml",
        name: packageTable !== undefined ? getTomlString(packageTable, "name") : null,
        version: packageTable !== undefined ? getTomlString(packageTable, "version") : null,
        dependencies,
        devDependencies,
      };
    } catch {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: "Could not parse manifest: Cargo.toml",
      });
      return null;
    }
  }

  private async readGoMod(
    root: string,
    warnings: InspectionWarning[],
  ): Promise<RepositoryManifest | null> {
    const content = await this.loadManifestFile(root, "go.mod", warnings);
    if (content === null) return null;

    try {
      const parsed = parseGoMod(content);
      if (parsed.name === null && parsed.dependencies.length === 0) {
        warnings.push({
          code: "MANIFEST_PARSE_FAILED",
          message: "go.mod has no module declaration or requirements",
        });
        return null;
      }
      return {
        ecosystem: "go",
        path: "go.mod",
        name: parsed.name,
        version: null,
        dependencies: parsed.dependencies,
        devDependencies: [],
      };
    } catch {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: "Could not parse manifest: go.mod",
      });
      return null;
    }
  }

  private async readRequirementsTxt(
    root: string,
    warnings: InspectionWarning[],
  ): Promise<RepositoryManifest | null> {
    const content = await this.loadManifestFile(root, "requirements.txt", warnings);
    if (content === null) return null;

    try {
      return {
        ecosystem: "python-requirements",
        path: "requirements.txt",
        name: null,
        version: null,
        dependencies: parseRequirementsTxt(content),
        devDependencies: [],
      };
    } catch {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: "Could not parse manifest: requirements.txt",
      });
      return null;
    }
  }
}
