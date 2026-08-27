import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { InspectionWarning } from "../domain/repository-summary.js";
import type {
  DetectedLockfile,
  DetectedWorkspaceDeclaration,
  RepositoryWorkspaceSummary,
  WorkspaceDeclarationKind,
} from "../domain/repository-workspace.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

// Filenames are matched exactly (not case-folded): several of these
// (Cargo.lock, Gemfile.lock, Pipfile.lock) are conventionally mixed-case
// and a case-insensitive match would risk false positives on
// case-sensitive filesystems.
const LOCKFILE_PACKAGE_MANAGERS: Readonly<Record<string, string>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "yarn",
  "pnpm-lock.yaml": "pnpm",
  "poetry.lock": "poetry",
  "Pipfile.lock": "pipenv",
  "uv.lock": "uv",
  "Cargo.lock": "cargo",
  "go.sum": "go",
  "composer.lock": "composer",
  "Gemfile.lock": "bundler",
};

interface PackageJsonManifest {
  readonly workspaces?: unknown;
}

function stripQuotesAndComment(token: string): string {
  const withoutComment = token.split("#")[0]?.trim() ?? "";
  if (withoutComment.length >= 2) {
    const first = withoutComment[0];
    const last = withoutComment[withoutComment.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return withoutComment.slice(1, -1);
    }
  }
  return withoutComment;
}

function parseInlineStringArray(body: string): string[] {
  return body
    .split(",")
    .map((token) => stripQuotesAndComment(token))
    .filter((token) => token.length > 0);
}

function extractNpmWorkspacePatterns(manifest: PackageJsonManifest): string[] | null {
  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces)) {
    const patterns = workspaces.filter((item): item is string => typeof item === "string");
    return patterns.length > 0 ? patterns : null;
  }
  if (typeof workspaces === "object" && workspaces !== null) {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      const patterns = packages.filter((item): item is string => typeof item === "string");
      return patterns.length > 0 ? patterns : null;
    }
  }
  return null;
}

/**
 * Extracts the `packages:` list from a pnpm-workspace.yaml file.
 *
 * This is a deliberately minimal, best-effort scanner rather than a full
 * YAML parser: it recognizes the top-level `packages:` key in both flow
 * (`packages: [a, b]`) and block (`packages:\n  - a\n  - b`) form, which is
 * the form pnpm's own documentation and tooling produce. Anything else is
 * left unrecognized (returns null) rather than mis-parsed.
 */
function parsePnpmWorkspacePackages(content: string): string[] | null {
  const lines = content.split(/\r\n|\r|\n/);
  const keyIndex = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (keyIndex === -1) return null;
  const keyLine = lines[keyIndex] ?? "";
  const afterColon = keyLine.replace(/^packages\s*:/, "").trim();

  if (afterColon.length > 0) {
    if (!afterColon.startsWith("[")) return null;
    let flowText = afterColon;
    let index = keyIndex;
    while (!flowText.includes("]") && index + 1 < lines.length) {
      index += 1;
      flowText += `\n${lines[index] ?? ""}`;
    }
    const match = flowText.match(/\[([\s\S]*)\]/);
    if (!match) return null;
    const items = parseInlineStringArray(match[1] ?? "");
    return items.length > 0 ? items : null;
  }

  const items: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    if (!/^\s/.test(line)) break; // next top-level key
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) break;
    const value = stripQuotesAndComment(trimmed.slice(1).trim());
    if (value.length > 0) items.push(value);
  }
  return items.length > 0 ? items : null;
}

/**
 * Extracts `[workspace] members = [...]` from a Cargo.toml file.
 *
 * As with the pnpm-workspace.yaml scanner above, this is a minimal
 * best-effort scanner (not a full TOML parser): it locates the `[workspace]`
 * table and a `members = [...]` array within it, supporting both
 * single-line and multi-line array syntax. Anything else is left
 * unrecognized (returns null) rather than mis-parsed.
 */
function parseCargoWorkspaceMembers(content: string): string[] | null {
  const lines = content.split(/\r\n|\r|\n/);
  const workspaceIndex = lines.findIndex((line) => line.trim() === "[workspace]");
  if (workspaceIndex === -1) return null;

  let sectionEnd = lines.length;
  for (let index = workspaceIndex + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim().startsWith("[")) {
      sectionEnd = index;
      break;
    }
  }
  const section = lines.slice(workspaceIndex + 1, sectionEnd);
  const memberLineIndex = section.findIndex((line) => /^members\s*=/.test(line.trim()));
  if (memberLineIndex === -1) return null;

  let arrayText = (section[memberLineIndex] ?? "").trim().replace(/^members\s*=\s*/, "");
  let index = memberLineIndex;
  while (!arrayText.includes("]") && index + 1 < section.length) {
    index += 1;
    arrayText += `\n${section[index] ?? ""}`;
  }
  const match = arrayText.match(/\[([\s\S]*)\]/);
  if (!match) return null;
  const items = parseInlineStringArray(match[1] ?? "");
  return items.length > 0 ? items : null;
}

export class RepositoryWorkspaceDetector {
  public constructor(
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async detect(repositoryPath: string): Promise<RepositoryWorkspaceSummary> {
    const root = await this.fileSystem.realPath(repositoryPath);
    if (!(await this.fileSystem.getStats(root)).isDirectory()) {
      throw new Error(`Repository path is not a directory: ${repositoryPath}`);
    }

    const warnings: InspectionWarning[] = [];
    const lockfiles: DetectedLockfile[] = [];
    const workspaceDeclarations: DetectedWorkspaceDeclaration[] = [];

    let entries: Dirent[];
    try {
      entries = await this.fileSystem.readDirectory(root);
    } catch {
      warnings.push({
        code: "PATH_UNREADABLE",
        message: "Could not read repository path: .",
      });
      entries = [];
    }

    for (const entry of entries) {
      // Only the repository root is scanned, and symbolic links are never
      // followed, per the read-only/bounded-traversal conventions used
      // elsewhere in this package.
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      const name = entry.name;
      const fullPath = join(root, name);

      const packageManager = LOCKFILE_PACKAGE_MANAGERS[name];
      if (packageManager !== undefined) {
        lockfiles.push({ path: name, packageManager });
      }

      if (name === "package.json") {
        const declaration = await this.readNpmWorkspaceDeclaration(fullPath, name, warnings);
        if (declaration !== null) workspaceDeclarations.push(declaration);
      } else if (name === "pnpm-workspace.yaml") {
        const declaration = await this.readDeclaration(
          fullPath,
          name,
          "pnpm-workspaces",
          parsePnpmWorkspacePackages,
          warnings,
        );
        if (declaration !== null) workspaceDeclarations.push(declaration);
      } else if (name === "Cargo.toml") {
        const declaration = await this.readDeclaration(
          fullPath,
          name,
          "cargo-workspace",
          parseCargoWorkspaceMembers,
          warnings,
        );
        if (declaration !== null) workspaceDeclarations.push(declaration);
      }
    }

    return {
      schemaVersion: 1,
      lockfiles: [...lockfiles].sort((left, right) => left.path.localeCompare(right.path)),
      workspaceDeclarations: [...workspaceDeclarations].sort((left, right) =>
        left.manifestPath.localeCompare(right.manifestPath),
      ),
      warnings,
    };
  }

  private async readBoundedText(
    path: string,
    displayName: string,
    warnings: InspectionWarning[],
  ): Promise<string | null> {
    try {
      const stats = await this.fileSystem.getStats(path);
      if (stats.size > MAX_MANIFEST_BYTES) {
        warnings.push({
          code: "MANIFEST_PARSE_FAILED",
          message: `Skipped oversized manifest: ${displayName}`,
        });
        return null;
      }
      return (await this.fileSystem.readFile(path)).toString("utf8");
    } catch {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: `Could not parse manifest: ${displayName}`,
      });
      return null;
    }
  }

  private async readNpmWorkspaceDeclaration(
    path: string,
    displayName: string,
    warnings: InspectionWarning[],
  ): Promise<DetectedWorkspaceDeclaration | null> {
    const text = await this.readBoundedText(path, displayName, warnings);
    if (text === null) return null;
    let manifest: PackageJsonManifest;
    try {
      manifest = JSON.parse(text) as PackageJsonManifest;
    } catch {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: `Could not parse manifest: ${displayName}`,
      });
      return null;
    }
    const patterns = extractNpmWorkspacePatterns(manifest);
    if (patterns === null) return null;
    return { manifestPath: displayName, kind: "npm-workspaces", patterns };
  }

  private async readDeclaration(
    path: string,
    displayName: string,
    kind: WorkspaceDeclarationKind,
    parse: (content: string) => string[] | null,
    warnings: InspectionWarning[],
  ): Promise<DetectedWorkspaceDeclaration | null> {
    const text = await this.readBoundedText(path, displayName, warnings);
    if (text === null) return null;
    let patterns: string[] | null;
    try {
      patterns = parse(text);
    } catch {
      warnings.push({
        code: "MANIFEST_PARSE_FAILED",
        message: `Could not parse manifest: ${displayName}`,
      });
      return null;
    }
    if (patterns === null) return null;
    return { manifestPath: displayName, kind, patterns };
  }
}
