import { join } from "node:path";
import type {
  CodeownersEntry,
  RepositoryOwnershipIndex,
} from "../domain/repository-ownership.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const MAX_CODEOWNERS_BYTES = 1024 * 1024;

const CODEOWNERS_LOCATIONS: readonly string[] = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

/**
 * Locates and parses the repository's CODEOWNERS file, following GitHub's
 * documented search order. Never throws: a missing file yields an empty
 * index, and malformed lines are skipped rather than failing the load.
 */
export class CodeownersOwnershipResolver {
  public constructor(
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async load(repositoryPath: string): Promise<RepositoryOwnershipIndex> {
    let root: string;
    try {
      root = await this.fileSystem.realPath(repositoryPath);
    } catch {
      return { schemaVersion: 1, sourcePath: null, entries: [] };
    }

    for (const relativeLocation of CODEOWNERS_LOCATIONS) {
      const candidate = join(root, relativeLocation);
      const content = await this.readIfPresent(candidate);
      if (content === null) continue;
      return {
        schemaVersion: 1,
        sourcePath: relativeLocation,
        entries: parseCodeowners(content),
      };
    }

    return { schemaVersion: 1, sourcePath: null, entries: [] };
  }

  private async readIfPresent(path: string): Promise<string | null> {
    let linkStats;
    try {
      linkStats = await this.fileSystem.getLinkStats(path);
    } catch {
      return null;
    }
    // Symlinks are excluded, matching the repository's symlink-exclusion
    // convention elsewhere in the codebase.
    if (linkStats.isSymbolicLink() || !linkStats.isFile()) return null;
    if (linkStats.size > MAX_CODEOWNERS_BYTES) return null;

    try {
      const buffer = await this.fileSystem.readFile(path);
      return buffer.toString("utf8");
    } catch {
      return null;
    }
  }
}

function parseCodeowners(content: string): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine === undefined) continue;
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const tokens = line.split(/\s+/).filter((token) => token.length > 0);
    const pattern = tokens[0];
    const owners = tokens.slice(1);
    if (pattern === undefined || owners.length === 0) continue;

    entries.push({ pattern, owners, lineNumber });
  }

  return entries;
}
