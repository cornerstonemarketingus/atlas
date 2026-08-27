import { join } from "node:path";
import type {
  DetectedRepositoryCommand,
  RepositoryCommandCategory,
  RepositoryCommandSummary,
} from "../domain/repository-commands.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const MAX_FILE_BYTES = 1024 * 1024;

const PACKAGE_JSON_SOURCE = "package.json";
const MAKEFILE_SOURCE = "Makefile";
const PYPROJECT_SOURCE = "pyproject.toml";

const PYPROJECT_SCRIPT_SECTIONS = new Set(["tool.poetry.scripts", "project.scripts"]);

const MAKEFILE_TARGET_PATTERN = /^([A-Za-z0-9_.-]+):(?!=)/;
const PYPROJECT_SECTION_PATTERN = /^\[([^\]]+)\]$/;
const PYPROJECT_ENTRY_PATTERN = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/;

/**
 * Statically parses well-known command-declaring files at the top level of a
 * repository (package.json scripts, a Makefile, pyproject.toml script
 * tables) and classifies each discovered command into a coarse category.
 *
 * This is detection/reporting only: no detected command is ever executed,
 * and no shell or package manager is invoked to perform the detection.
 */
export class RepositoryCommandDetector {
  public constructor(
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async detect(repositoryPath: string): Promise<RepositoryCommandSummary> {
    const root = await this.resolveRoot(repositoryPath);

    const commands: DetectedRepositoryCommand[] = [
      ...(await this.detectPackageJsonScripts(root)),
      ...(await this.detectMakefileTargets(root)),
      ...(await this.detectPyprojectScripts(root)),
    ];

    commands.sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.name.localeCompare(right.name) ||
        left.command.localeCompare(right.command),
    );

    return { schemaVersion: 1, commands };
  }

  private async resolveRoot(repositoryPath: string): Promise<string> {
    try {
      return await this.fileSystem.realPath(repositoryPath);
    } catch {
      return repositoryPath;
    }
  }

  /**
   * Reads a top-level file defensively: missing files, symlinks, non-files,
   * and oversized files all resolve to `null` rather than throwing.
   */
  private async readBoundedFile(fullPath: string): Promise<string | null> {
    try {
      const linkStats = await this.fileSystem.getLinkStats(fullPath);
      if (linkStats.isSymbolicLink() || !linkStats.isFile()) return null;
      if (linkStats.size > MAX_FILE_BYTES) return null;
      const buffer = await this.fileSystem.readFile(fullPath);
      return buffer.toString("utf8");
    } catch {
      return null;
    }
  }

  private async detectPackageJsonScripts(root: string): Promise<DetectedRepositoryCommand[]> {
    const content = await this.readBoundedFile(join(root, PACKAGE_JSON_SOURCE));
    if (content === null) return [];

    let manifest: unknown;
    try {
      manifest = JSON.parse(content);
    } catch {
      return [];
    }
    if (typeof manifest !== "object" || manifest === null) return [];

    const scripts = (manifest as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return [];

    const results: DetectedRepositoryCommand[] = [];
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value !== "string") continue;
      results.push({
        category: classifyCommand(name, value),
        name,
        command: value,
        source: PACKAGE_JSON_SOURCE,
      });
    }
    return results;
  }

  private async detectMakefileTargets(root: string): Promise<DetectedRepositoryCommand[]> {
    const content = await this.readBoundedFile(join(root, MAKEFILE_SOURCE));
    if (content === null) return [];

    const results: DetectedRepositoryCommand[] = [];
    const seen = new Set<string>();
    for (const rawLine of content.split(/\r\n|\r|\n/)) {
      const match = MAKEFILE_TARGET_PATTERN.exec(rawLine);
      if (match === null) continue;
      const name = match[1];
      if (name === undefined || name.startsWith(".")) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      results.push({
        category: classifyCommand(name, name),
        name,
        command: name,
        source: MAKEFILE_SOURCE,
      });
    }
    return results;
  }

  private async detectPyprojectScripts(root: string): Promise<DetectedRepositoryCommand[]> {
    const content = await this.readBoundedFile(join(root, PYPROJECT_SOURCE));
    if (content === null) return [];

    const results: DetectedRepositoryCommand[] = [];
    let currentSection: string | null = null;
    for (const rawLine of content.split(/\r\n|\r|\n/)) {
      const line = stripTomlComment(rawLine).trim();
      if (line.length === 0) continue;

      const sectionMatch = PYPROJECT_SECTION_PATTERN.exec(line);
      if (sectionMatch !== null) {
        currentSection = sectionMatch[1]?.trim() ?? null;
        continue;
      }
      if (currentSection === null || !PYPROJECT_SCRIPT_SECTIONS.has(currentSection)) continue;

      const entryMatch = PYPROJECT_ENTRY_PATTERN.exec(line);
      if (entryMatch === null) continue;
      const name = entryMatch[1];
      const rawValue = entryMatch[2];
      if (name === undefined || rawValue === undefined) continue;
      const value = unquoteTomlValue(rawValue.trim());
      if (value === null) continue;

      results.push({
        category: classifyCommand(name, value),
        name,
        command: value,
        source: PYPROJECT_SOURCE,
      });
    }
    return results;
  }
}

/**
 * Strips a trailing `#` comment from a single TOML line, ignoring `#`
 * characters that appear inside a quoted string.
 */
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

/**
 * Unwraps a minimal, flat TOML scalar value. Only quoted strings are
 * supported; arrays, inline tables, and other nested structures return
 * `null` so callers can skip them defensively rather than misparse them.
 */
function unquoteTomlValue(value: string): string | null {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return null;
}

const TYPECHECK_PATTERN = /\btype[-_]?check(ing)?\b|--noemit\b/;
const FORMAT_PATTERN = /\b(format|fmt|prettier|rustfmt|gofmt|black|autopep8)\b/;
const LINT_PATTERN = /\b(lint|eslint|tslint|ruff|flake8|pylint|stylelint|clippy)\b/;
const TEST_PATTERN = /\b(test|tests|jest|vitest|mocha|pytest|ava|node --test)\b/;
const BUILD_PATTERN = /\b(build|compile|webpack|rollup|esbuild|tsc)\b/;
const WATCH_PATTERN = /\b(dev|watch|nodemon)\b|--watch\b/;

/**
 * Best-effort classification of a detected command using keyword heuristics
 * against both the declared name and the command text. Order matters: more
 * specific categories (typecheck, format, lint, test) are checked before the
 * broader "build" and "dev" buckets so that, for example, "tsc --noEmit" is
 * classified as typecheck rather than build.
 */
function classifyCommand(name: string, command: string): RepositoryCommandCategory {
  const haystack = `${name} ${command}`.toLowerCase();

  if (TYPECHECK_PATTERN.test(haystack)) return "typecheck";
  if (FORMAT_PATTERN.test(haystack)) return "format";
  if (LINT_PATTERN.test(haystack)) return "lint";
  if (TEST_PATTERN.test(haystack)) return "test";
  if (BUILD_PATTERN.test(haystack)) return "build";
  if (WATCH_PATTERN.test(haystack)) return "dev";

  return "other";
}
