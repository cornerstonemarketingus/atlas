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
  /** Optional serialized request byte ceiling, including tool schemas. */
  readonly maximumRequestBytes?: number;
  /**
   * Caps `max_tokens` on every individual model request. Without this, a
   * provider that reports a large remaining output-token budget (see
   * BudgetedModelProvider) will ask for the entire remaining budget on a
   * single turn — which real providers can reject outright (Groq returns
   * HTTP 413 once a request's prompt + max_tokens exceeds its tokens-per-
   * minute limit, well before the conversation itself is actually large).
   * Defaults to 4,096, generous for a single tool call or summary turn.
   */
  readonly maximumOutputTokensPerTurn?: number;
  /**
   * Overrides the default read-only system prompt. Set this whenever any
   * offered tool is not capability "read" — the default text explicitly
   * tells the model to "never request mutation", which would suppress a
   * write tool's use even when the registry's policy allows it.
   */
  readonly systemPrompt?: string;
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
