import type {
  ToolPolicy,
  ToolPolicyEvaluation,
  ToolRiskLevel,
  ToolScope,
} from "./tool-policy.js";

export interface ReadOnlyToolContext {
  readonly repositoryId: string;
  readonly signal?: AbortSignal;
}

export interface ReadOnlyToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRiskLevel;
  readonly validateInput: (input: unknown) => TInput;
  readonly execute: (input: TInput, context: ReadOnlyToolContext) => Promise<TOutput>;
}

export interface ReadOnlyToolExecutionRequest {
  readonly name: string;
  readonly input: unknown;
  readonly scope: ToolScope;
  readonly context: ReadOnlyToolContext;
}

export type ReadOnlyToolExecutionResult =
  | {
      readonly status: "completed";
      readonly output: unknown;
      readonly policy: ToolPolicyEvaluation;
    }
  | {
      readonly status: "approval-required";
      readonly policy: ToolPolicyEvaluation;
    };

export type ReadOnlyToolRegistryErrorCode =
  | "DUPLICATE_TOOL"
  | "EMPTY_TOOL_NAME"
  | "POLICY_DENIED"
  | "SCOPE_MISMATCH"
  | "TOOL_NOT_FOUND";

export class ReadOnlyToolRegistryError extends Error {
  public constructor(
    public readonly code: ReadOnlyToolRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReadOnlyToolRegistryError";
  }
}

export interface ReadOnlyToolRegistry {
  register<TInput, TOutput>(definition: ReadOnlyToolDefinition<TInput, TOutput>): void;
  list(): readonly Pick<ReadOnlyToolDefinition<unknown, unknown>, "name" | "description" | "risk">[];
  execute(request: ReadOnlyToolExecutionRequest): Promise<ReadOnlyToolExecutionResult>;
}

export interface ReadOnlyToolRegistryOptions {
  readonly policy: ToolPolicy;
}
