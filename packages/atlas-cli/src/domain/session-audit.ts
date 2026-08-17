export const SESSION_EVENT_SCHEMA_VERSION = 1 as const;

export type SessionEventType =
  | "session.started"
  | "session.completed"
  | "session.blocked"
  | "session.failed"
  | "model.requested"
  | "model.responded"
  | "tool.requested"
  | "tool.policy_decided"
  | "tool.completed"
  | "budget.updated"
  | "approval.recorded"
  | "error.recorded";

export interface SessionStartedPayload {
  readonly sessionId: string;
  readonly repositoryId?: string;
}

export interface SessionTerminalPayload {
  readonly sessionId: string;
  readonly summary: string;
}

export interface ModelRequestedPayload {
  readonly requestId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly messageCount: number;
  readonly inputCharacters: number;
  readonly toolsOffered: number;
  readonly contentDigest?: string;
}

export interface ModelRespondedPayload {
  readonly requestId: string;
  readonly responseId?: string;
  readonly finishReason: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly outputCharacters: number;
  readonly toolCallCount: number;
  readonly contentDigest?: string;
}

export interface ToolRequestedPayload {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolId: string;
  readonly argumentCount: number;
  readonly argumentsDigest?: string;
}

export interface ToolPolicyDecidedPayload {
  readonly toolCallId: string;
  readonly decision: "allow" | "ask" | "deny";
  readonly ruleId?: string;
  readonly reason: string;
}

export interface ToolCompletedPayload {
  readonly toolCallId: string;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly durationMs: number;
  readonly resultCharacters: number;
  readonly resultDigest?: string;
  readonly errorCode?: string;
}

export interface BudgetUpdatedPayload {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly elapsedMs: number;
  readonly costMicrounits: number;
}

export interface ApprovalRecordedPayload {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly decision: "approved" | "rejected" | "cancelled";
  readonly actorId?: string;
  readonly reason?: string;
}

export interface ErrorRecordedPayload {
  readonly code: string;
  readonly summary: string;
  readonly recoverable: boolean;
  readonly relatedId?: string;
}

export interface SessionEventPayloadMap {
  readonly "session.started": SessionStartedPayload;
  readonly "session.completed": SessionTerminalPayload;
  readonly "session.blocked": SessionTerminalPayload;
  readonly "session.failed": SessionTerminalPayload;
  readonly "model.requested": ModelRequestedPayload;
  readonly "model.responded": ModelRespondedPayload;
  readonly "tool.requested": ToolRequestedPayload;
  readonly "tool.policy_decided": ToolPolicyDecidedPayload;
  readonly "tool.completed": ToolCompletedPayload;
  readonly "budget.updated": BudgetUpdatedPayload;
  readonly "approval.recorded": ApprovalRecordedPayload;
  readonly "error.recorded": ErrorRecordedPayload;
}

export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  readonly schemaVersion: typeof SESSION_EVENT_SCHEMA_VERSION;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: T;
  readonly payload: Readonly<SessionEventPayloadMap[T]>;
};

export interface SessionAuditLog {
  append<T extends SessionEventType>(
    type: T,
    payload: SessionEventPayloadMap[T],
  ): SessionEvent<T>;
  snapshot(): readonly SessionEvent[];
  readonly size: number;
  readonly capacity: number;
}
