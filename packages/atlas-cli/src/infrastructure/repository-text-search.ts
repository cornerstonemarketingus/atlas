import type {
  RepositorySearchMatch,
  RepositorySearchOptions,
  RepositorySearchResult,
  RepositorySearcher,
  RepositorySearchWarning,
  SearchScope,
} from "../domain/repository-search.js";
import { GitClient } from "./git-client.js";
import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const DEFAULTS = {
  maxFiles: 20_000,
  maxResults: 100,
  maxFileBytes: 1024 * 1024,
  maxDepth: 25,
  scope: "all" as SearchScope,
};

export class RepositoryTextSearch implements RepositorySearcher {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async search(
    repositoryPath: string,
    query: string,
    options: RepositorySearchOptions = {},
  ): Promise<RepositorySearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || normalizedQuery.length > 200) {
      throw new Error("Search query must contain 1–200 non-whitespace characters.");
    }

    const limits = { ...DEFAULTS, ...options };
    if (limits.maxFiles < 1 || limits.maxResults < 1 || limits.maxFileBytes < 1 || limits.maxDepth < 0) {
      throw new Error("Search limits must be positive; maxDepth may be zero.");
    }
    const matches: RepositorySearchMatch[] = [];
    const warnings: RepositorySearchWarning[] = [];
    let resultLimitReached = false;
    const enumeration = await new RepositoryFileEnumerator(
      this.gitClient,
      this.fileSystem,
    ).enumerate(repositoryPath, {
      maxFiles: limits.maxFiles,
      maxDepth: limits.maxDepth,
    });
    warnings.push(...enumeration.warnings);

    const needle = normalizedQuery.toLocaleLowerCase();
    for (const file of enumeration.files) {
      const displayPath = file.relativePath;

      if (limits.scope !== "content" && displayPath.toLocaleLowerCase().includes(needle)) {
        matches.push({ kind: "file", path: displayPath });
      }
      if (matches.length >= limits.maxResults) {
        resultLimitReached = true;
        break;
      }
      if (limits.scope === "files" || file.size > limits.maxFileBytes) continue;

      let buffer;
      try {
        buffer = await this.fileSystem.readFile(file.absolutePath);
      } catch {
        warnings.push({
          code: "PATH_UNREADABLE",
          message: `Could not read repository path: ${displayPath}`,
        });
        continue;
      }
      if (buffer.subarray(0, 8_192).includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const column = line.toLocaleLowerCase().indexOf(needle);
        if (column < 0) continue;
        matches.push({
          kind: "content",
          path: displayPath,
          line: index + 1,
          column: column + 1,
          preview: line.trim().slice(0, 240),
        });
        if (matches.length >= limits.maxResults) {
          resultLimitReached = true;
          break;
        }
      }
      if (resultLimitReached) break;
    }

    if (enumeration.limitReached) {
      warnings.push({
        code: "FILE_LIMIT_REACHED",
        message: `Search stopped after ${limits.maxFiles} files.`,
      });
    }
    if (resultLimitReached) {
      warnings.push({
        code: "RESULT_LIMIT_REACHED",
        message: `Search stopped after ${limits.maxResults} matches.`,
      });
    }

    return {
      schemaVersion: 1,
      root: enumeration.root,
      query: normalizedQuery,
      scope: limits.scope,
      filesScanned: enumeration.files.length,
      matches,
      warnings,
    };
  }
}
