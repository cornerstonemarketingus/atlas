export type ApprovalDecision = "approved" | "rejected" | "cancelled";

export interface PendingToolApproval {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly toolId: string;
  readonly toolCallId: string;
  readonly arguments: unknown;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface CreatePendingToolApproval {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly toolId: string;
  readonly toolCallId: string;
  readonly arguments: unknown;
}

export interface ApprovalResumeBinding {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly toolId: string;
  readonly toolCallId: string;
}

export interface IssuedApprovalResume {
  readonly token: string;
  readonly pending: PendingToolApproval;
}

export type ApprovalResumeResult =
  | { readonly status: ApprovalDecision; readonly pending: PendingToolApproval }
  | { readonly status: "expired" }
  | { readonly status: "unknown" }
  | { readonly status: "binding-mismatch" };

export interface ApprovalResumeStore {
  issue(pending: CreatePendingToolApproval): IssuedApprovalResume;
  consume(
    token: string,
    binding: ApprovalResumeBinding,
    decision: ApprovalDecision,
  ): ApprovalResumeResult;
  readonly size: number;
}

