/**
 * Four operations, each content-addressed. `create` and `update` rewrite a
 * file's whole contents; `delete` removes one; `rename` moves one without
 * touching its bytes. Every operation that touches an existing file carries the
 * hash the caller believes is on disk, so a concurrent modification is rejected
 * instead of silently overwritten.
 */
export type RepositoryFileEditOperation = "create" | "update" | "delete" | "rename";

/** `mustNotExist` is required so a create can never be mistaken for an overwrite. */
export interface RepositoryFileCreateRequest {
  readonly operation: "create";
  readonly path: string;
  readonly content: string;
  readonly mustNotExist: true;
}

export interface RepositoryFileUpdateRequest {
  readonly operation: "update";
  readonly path: string;
  readonly content: string;
  readonly expectedSha256: string;
}

/** Deletes carry a hash too: the caller must prove which bytes it is destroying. */
export interface RepositoryFileDeleteRequest {
  readonly operation: "delete";
  readonly path: string;
  readonly expectedSha256: string;
}

/** `toPath` must be repository-relative and must not already exist. */
export interface RepositoryFileRenameRequest {
  readonly operation: "rename";
  readonly path: string;
  readonly toPath: string;
  readonly expectedSha256: string;
}

export type RepositoryFileEditRequest =
  | RepositoryFileCreateRequest
  | RepositoryFileUpdateRequest
  | RepositoryFileDeleteRequest
  | RepositoryFileRenameRequest;

export interface RepositoryFileEditPlan {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly operation: RepositoryFileEditOperation;
  readonly path: string;
  /** Rename destination, repository-relative; null for every other operation. */
  readonly toPath: string | null;
  readonly expectedSha256: string | null;
  readonly beforeSha256: string | null;
  /** Hash of the bytes the operation leaves behind; null for a delete. */
  readonly afterSha256: string | null;
  readonly contentBytes: number;
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly planDigest: string;
}

export interface RepositoryFileEditApproval {
  readonly approved: true;
  readonly planDigest: string;
}

export interface RepositoryFileEditResult {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly operation: RepositoryFileEditOperation;
  readonly path: string;
  readonly toPath: string | null;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly planDigest: string;
}

export interface RepositoryFileEditor {
  preview(repositoryPath: string, request: RepositoryFileEditRequest): Promise<RepositoryFileEditPlan>;
  apply(plan: RepositoryFileEditPlan, approval: RepositoryFileEditApproval): Promise<RepositoryFileEditResult>;
  discard(planDigest: string): boolean;
}

export type RepositoryFileEditErrorCode =
  | "ABSOLUTE_PATH_NOT_ALLOWED"
  | "PATH_OUTSIDE_REPOSITORY"
  | "SYMLINK_NOT_ALLOWED"
  | "PARENT_NOT_DIRECTORY"
  | "FILE_ALREADY_EXISTS"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "EXPECTED_HASH_REQUIRED"
  | "STALE_FILE"
  | "INVALID_TEXT"
  | "CHANGE_TOO_LARGE"
  | "APPROVAL_MISMATCH"
  | "INVALID_PLAN"
  | "PLAN_CAPACITY_REACHED"
  | "IO_ERROR";

export class RepositoryFileEditError extends Error {
  public constructor(
    public readonly code: RepositoryFileEditErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositoryFileEditError";
  }
}
