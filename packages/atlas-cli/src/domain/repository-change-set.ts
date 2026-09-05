import type {
  RepositoryFileEditApproval,
  RepositoryFileEditPlan,
  RepositoryFileEditRequest,
  RepositoryFileEditResult,
} from "./repository-file-edit.js";

/**
 * An ordered, compensating transaction over single-file edits. It now spans all
 * four edit operations — create, update, delete, and rename — because a real
 * refactor moves and removes files, and splitting that across independent
 * single-file writes leaves the working tree half-edited when one write fails.
 * It is still not a general filesystem transaction: directories are never
 * created or removed, and compensation is best-effort replay of the inverse
 * edit rather than a journalled rollback.
 */
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
  | "CHANGE_SET_TOO_LARGE"
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
