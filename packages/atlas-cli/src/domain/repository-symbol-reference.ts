export type RepositorySymbolOccurrenceKind = "declaration" | "reference";

export interface RepositorySymbolOccurrence {
  readonly name: string;
  readonly classification: RepositorySymbolOccurrenceKind;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly language: "javascript" | "python" | "typescript";
}

export interface RepositorySymbolReferenceWarning {
  readonly code:
    | "FILE_LIMIT_REACHED"
    | "FILE_TOO_LARGE"
    | "GIT_ENUMERATION_FAILED"
    | "PATH_UNREADABLE"
    | "RESULT_LIMIT_REACHED"
    | "TOTAL_BYTE_LIMIT_REACHED";
  readonly message: string;
}

export interface RepositorySymbolReferenceResult {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly query: string;
  readonly filesScanned: number;
  readonly bytesScanned: number;
  readonly occurrences: readonly RepositorySymbolOccurrence[];
  readonly warnings: readonly RepositorySymbolReferenceWarning[];
}

export interface RepositorySymbolReferenceOptions {
  readonly maxFiles?: number;
  readonly maxResults?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxDepth?: number;
}

export interface RepositorySymbolReferenceFinder {
  find(
    repositoryPath: string,
    symbolName: string,
    options?: RepositorySymbolReferenceOptions,
  ): Promise<RepositorySymbolReferenceResult>;
}
