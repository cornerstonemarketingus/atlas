export type RepositorySymbolKind =
  | "class"
  | "enum"
  | "function"
  | "interface"
  | "type";

export interface RepositorySymbol {
  readonly name: string;
  readonly kind: RepositorySymbolKind;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly language: "javascript" | "python" | "typescript";
}

export interface RepositorySymbolWarning {
  readonly code:
    | "FILE_LIMIT_REACHED"
    | "GIT_ENUMERATION_FAILED"
    | "PATH_UNREADABLE"
    | "SYMBOL_LIMIT_REACHED";
  readonly message: string;
}

export interface RepositorySymbolResult {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly query: string | null;
  readonly filesScanned: number;
  readonly symbols: readonly RepositorySymbol[];
  readonly warnings: readonly RepositorySymbolWarning[];
}

export interface RepositorySymbolOptions {
  readonly query?: string;
  readonly maxFiles?: number;
  readonly maxSymbols?: number;
  readonly maxFileBytes?: number;
  readonly maxDepth?: number;
}

export interface RepositorySymbolIndexer {
  index(
    repositoryPath: string,
    options?: RepositorySymbolOptions,
  ): Promise<RepositorySymbolResult>;
}
