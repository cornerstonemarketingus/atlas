export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface JsonContent {
  readonly type: "json";
  readonly value: JsonValue;
}

export interface ToolCallContent {
  readonly type: "tool-call";
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

export type InputContent = TextContent | JsonContent;
export type AssistantContent = TextContent | ToolCallContent;

export interface SystemMessage {
  readonly role: "system";
  readonly content: readonly TextContent[];
}

export interface UserMessage {
  readonly role: "user";
  readonly content: readonly InputContent[];
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly AssistantContent[];
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly content: readonly InputContent[];
}

export type ModelMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema describing the tool's object arguments. */
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly responseFormat?: "text" | "json";
}

export type ModelFinishReason =
  | "stop"
  | "tool-calls"
  | "length"
  | "content-filter"
  | "cancelled"
  | "error"
  | "other";

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface ModelResponse {
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly message: AssistantMessage;
  readonly finishReason: ModelFinishReason;
  readonly usage: ModelUsage;
}

export interface ModelCapabilities {
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsTools: boolean;
  readonly supportsJson: boolean;
  readonly supportsStreaming: boolean;
}

export interface ModelProviderMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly models: readonly ModelCapabilities[];
}

export interface ModelCompletionOptions {
  readonly signal?: AbortSignal;
}

export interface ModelProvider {
  readonly metadata: ModelProviderMetadata;
  complete(
    request: ModelRequest,
    options?: ModelCompletionOptions,
  ): Promise<ModelResponse>;
}

export type ModelProviderErrorCode =
  | "authentication"
  | "rate-limit"
  | "invalid-request"
  | "model-unavailable"
  | "cancelled"
  | "provider-failure";

export class ModelProviderError extends Error {
  public readonly code: ModelProviderErrorCode;
  public readonly providerId: string;
  public readonly retryable: boolean;
  /** How long the provider said to wait before trying again, when it said. */
  public readonly retryAfterMs: number | undefined;

  public constructor(options: {
    readonly message: string;
    readonly code: ModelProviderErrorCode;
    readonly providerId: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelProviderError";
    this.code = options.code;
    this.providerId = options.providerId;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}
