/**
 * An opaque, one-time approval boundary for a change set.  The change-set
 * digest is the only change-related value retained here: callers must keep
 * file paths, diffs, and content in their own short-lived plan store.
 */
export type ChangeSetApprovalDecision = "approved" | "rejected" | "cancelled";

export interface ChangeSetApprovalRequest {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly changeSetDigest: string;
}

export interface ChangeSetApprovalBinding extends ChangeSetApprovalRequest {}

export interface PendingChangeSetApproval extends ChangeSetApprovalRequest {
  readonly approvalId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/** Safe to serialize: contains no raw token, edit content, paths, or diffs. */
export interface PersistedChangeSetApprovalRecord extends PendingChangeSetApproval {
  readonly tokenHash: string;
  readonly state: "pending" | ChangeSetApprovalDecision;
  readonly decidedAtMs?: number;
}

export interface IssuedChangeSetApproval {
  /** Cryptographically random capability; never persist or log this value. */
  readonly token: string;
  readonly pending: PendingChangeSetApproval;
}

export type ChangeSetApprovalConsumeResult =
  | { readonly status: ChangeSetApprovalDecision; readonly record: PersistedChangeSetApprovalRecord }
  | { readonly status: "expired" }
  | { readonly status: "unknown" }
  | { readonly status: "binding-mismatch" }
  | { readonly status: "replayed" };

export interface ChangeSetApprovalResumeStore {
  issue(request: ChangeSetApprovalRequest): IssuedChangeSetApproval;
  consume(token: string, binding: ChangeSetApprovalBinding, decision: ChangeSetApprovalDecision): ChangeSetApprovalConsumeResult;
  snapshot(): readonly PersistedChangeSetApprovalRecord[];
  readonly size: number;
}
