import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import { normalizeRepositoryRelativePath } from "../domain/repository-location.js";
import type { RepositoryTreeEntry, RepositoryTreeResult } from "../domain/repository-tree.js";

export class RepositoryTreeBuilder {
  public constructor(private readonly enumerator = new RepositoryFileEnumerator()) {}

  public async build(repositoryPath: string, maxDepth = 4, maxEntries = 500): Promise<RepositoryTreeResult> {
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) throw new Error("Tree maxDepth must be an integer between 0 and 32.");
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) throw new Error("Tree maxEntries must be an integer between 1 and 10000.");
    const result = await this.enumerator.enumerate(repositoryPath, { maxFiles: maxEntries + 1, maxDepth });
    const entries = new Map<string, RepositoryTreeEntry>();
    for (const file of result.files) {
      const path = normalizeRepositoryRelativePath(file.relativePath);
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const directory = parts.slice(0, index).join("/");
        entries.set(`d:${directory}`, { path: normalizeRepositoryRelativePath(directory), kind: "directory", depth: index - 1 });
      }
      entries.set(`f:${path}`, { path, kind: "file", depth: parts.length - 1 });
    }
    const ordered = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
    const truncated = result.limitReached || ordered.length > maxEntries;
    return {
      schemaVersion: 1,
      root: result.root,
      entries: ordered.slice(0, maxEntries),
      truncated,
      warnings: result.warnings.map((warning) => warning.message),
    };
  }
}
