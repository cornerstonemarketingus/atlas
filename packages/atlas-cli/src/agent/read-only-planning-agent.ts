import type { ModelMessage, ModelUsage } from "../model/model-provider.js";

export interface RepositoryEvidence {
  readonly label: string;
  readonly content: string;
}

export interface ReadOnlyPlanningRequest {
  readonly objective: string;
  readonly evidence: readonly RepositoryEvidence[];
  readonly signal?: AbortSignal;
}

export type PlanningBlockerCode =
  | "invalid-input"
  | "tool-call-unsupported"
  | "output-truncated"
  | "content-filtered"
  | "turn-limit"
  | "empty-response";

export interface PlanningTrace {
  readonly turns: number;
  readonly messages: readonly ModelMessage[];
  readonly usage: ModelUsage;
}

export interface CompletedPlanningResult {
  readonly status: "completed";
  readonly response: string;
  readonly trace: PlanningTrace;
}

export interface BlockedPlanningResult {
  readonly status: "blocked";
  readonly blocker: PlanningBlockerCode;
  readonly message: string;
  readonly partialResponse?: string;
  readonly trace: PlanningTrace;
}

export interface CancelledPlanningResult {
  readonly status: "cancelled";
  readonly message: string;
  readonly trace: PlanningTrace;
}

export interface FailedPlanningResult {
  readonly status: "failed";
  readonly message: string;
  readonly retryable: boolean;
  readonly providerId?: string;
  readonly trace: PlanningTrace;
}

export type ReadOnlyPlanningResult =
  | CompletedPlanningResult
  | BlockedPlanningResult
  | CancelledPlanningResult
  | FailedPlanningResult;

export interface ReadOnlyPlanningAgent {
  plan(request: ReadOnlyPlanningRequest): Promise<ReadOnlyPlanningResult>;
}
