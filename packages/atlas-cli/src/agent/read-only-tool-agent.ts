import type { ReadOnlyToolContext, ReadOnlyToolRegistry } from "../domain/read-only-tool-registry.js";
import type { SessionAuditLog } from "../domain/session-audit.js";
import type { ToolScope } from "../domain/tool-policy.js";
import type { ModelMessage, ModelProvider, ModelToolDefinition, ModelUsage } from "../model/model-provider.js";

export interface ReadOnlyToolAgentOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly registry: ReadOnlyToolRegistry;
  readonly tools: readonly ModelToolDefinition[];
  readonly audit: SessionAuditLog;
  readonly maximumTurns?: number;
  readonly maximumToolCalls?: number;
  readonly maximumToolResultCharacters?: number;
}

export interface ReadOnlyToolAgentRequest {
  readonly sessionId: string;
  readonly objective: string;
  readonly evidence: readonly { readonly label: string; readonly content: string }[];
  readonly scope: ToolScope;
  readonly context: ReadOnlyToolContext;
  readonly signal?: AbortSignal;
}

export interface ReadOnlyToolAgentTrace {
  readonly turns: number;
  readonly toolCalls: number;
  readonly usage: ModelUsage;
  readonly messages: readonly ModelMessage[];
}

export type ReadOnlyToolAgentResult =
  | { readonly status: "completed"; readonly response: string; readonly trace: ReadOnlyToolAgentTrace }
  | { readonly status: "approval-required"; readonly toolCallId: string; readonly toolName: string; readonly trace: ReadOnlyToolAgentTrace }
  | { readonly status: "blocked"; readonly message: string; readonly trace: ReadOnlyToolAgentTrace }
  | { readonly status: "cancelled"; readonly message: string; readonly trace: ReadOnlyToolAgentTrace }
  | { readonly status: "failed"; readonly message: string; readonly trace: ReadOnlyToolAgentTrace };
