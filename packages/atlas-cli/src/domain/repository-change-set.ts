import type {
  RepositoryFileEditApproval,
  RepositoryFileEditPlan,
  RepositoryFileEditRequest,
  RepositoryFileEditResult,
} from "./repository-file-edit.js";

/** A deliberately small transaction: only create and update edits are supported. */
export interface RepositoryChangeSetPlan {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly edits: readonly RepositoryFileEditPlan[];
  readonly changeSetDigest: string;
}

export interface RepositoryChangeSetApproval {
  readonly approved: true;
  readonly changeSetDigest: string;
}

export type RepositoryChangeSetRollbackStatus = "not-needed" | "rolled-back" | "rollback-failed";

export interface RepositoryChangeSetResult {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly changeSetDigest: string;
  readonly applied: readonly RepositoryFileEditResult[];
  readonly rollbackStatus: RepositoryChangeSetRollbackStatus;
  readonly rolledBackPaths: readonly string[];
  readonly rollbackFailedPaths: readonly string[];
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface RepositoryChangeSetEditor {
  preview(repositoryPath: string, requests: readonly RepositoryFileEditRequest[]): Promise<RepositoryChangeSetPlan>;
  apply(plan: RepositoryChangeSetPlan, approval: RepositoryChangeSetApproval): Promise<RepositoryChangeSetResult>;
  discard(changeSetDigest: string): boolean;
}

export type RepositoryChangeSetErrorCode =
  | "EMPTY_CHANGE_SET"
  | "DUPLICATE_PATH"
  | "ROOT_MISMATCH"
  | "APPROVAL_MISMATCH"
  | "INVALID_PLAN"
  | "PLAN_CAPACITY_REACHED"
  | "ROLLBACK_FAILED";

export class RepositoryChangeSetError extends Error {
  public constructor(
    public readonly code: RepositoryChangeSetErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositoryChangeSetError";
  }
}

export type { RepositoryFileEditApproval };
