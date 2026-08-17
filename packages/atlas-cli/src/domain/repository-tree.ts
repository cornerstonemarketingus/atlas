import type { RepositoryRelativePath } from "./repository-location.js";

export interface RepositoryTreeEntry {
  readonly path: RepositoryRelativePath;
  readonly kind: "directory" | "file";
  readonly depth: number;
}

export interface RepositoryTreeResult {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly entries: readonly RepositoryTreeEntry[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}
