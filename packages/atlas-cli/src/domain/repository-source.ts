export interface RepositorySourceReadOptions {
  readonly startLine?: number;
  readonly endLine?: number;
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

export interface RepositorySourceReadResult {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number | null;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly truncatedByBytes: boolean;
  readonly truncatedByLines: boolean;
}

export type RepositorySourceReadErrorCode =
  | "ABSOLUTE_PATH_NOT_ALLOWED"
  | "BINARY_FILE"
  | "INVALID_LINE_RANGE"
  | "INVALID_LIMIT"
  | "PATH_OUTSIDE_REPOSITORY"
  | "PATH_UNREADABLE"
  | "SOURCE_NOT_FILE"
  | "SYMLINK_NOT_ALLOWED"
  | "UNSUPPORTED_ENCODING";

export class RepositorySourceReadError extends Error {
  public constructor(
    public readonly code: RepositorySourceReadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositorySourceReadError";
  }
}

export interface RepositorySourceReader {
  read(
    repositoryPath: string,
    relativePath: string,
    options?: RepositorySourceReadOptions,
  ): Promise<RepositorySourceReadResult>;
}
