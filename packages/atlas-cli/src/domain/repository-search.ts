export type SearchScope = "all" | "content" | "files";

export interface FileSearchMatch {
  readonly kind: "file";
  readonly path: string;
}

export interface ContentSearchMatch {
  readonly kind: "content";
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export type RepositorySearchMatch = FileSearchMatch | ContentSearchMatch;

export interface RepositorySearchWarning {
  readonly code:
    | "FILE_LIMIT_REACHED"
    | "GIT_ENUMERATION_FAILED"
    | "PATH_UNREADABLE"
    | "RESULT_LIMIT_REACHED";
  readonly message: string;
}

export interface RepositorySearchResult {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly query: string;
  readonly scope: SearchScope;
  readonly filesScanned: number;
  readonly matches: readonly RepositorySearchMatch[];
  readonly warnings: readonly RepositorySearchWarning[];
}

export interface RepositorySearchOptions {
  readonly scope?: SearchScope;
  readonly maxFiles?: number;
  readonly maxResults?: number;
  readonly maxFileBytes?: number;
  readonly maxDepth?: number;
}

export interface RepositorySearcher {
  search(
    repositoryPath: string,
    query: string,
    options?: RepositorySearchOptions,
  ): Promise<RepositorySearchResult>;
}
