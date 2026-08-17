export type RepositoryFileEditOperation = "create" | "update";

export interface RepositoryFileEditRequest {
  readonly operation: RepositoryFileEditOperation;
  readonly path: string;
  readonly content: string;
  readonly expectedSha256?: string;
  readonly mustNotExist?: true;
}

export interface RepositoryFileEditPlan {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly operation: RepositoryFileEditOperation;
  readonly path: string;
  readonly expectedSha256: string | null;
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
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
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
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
