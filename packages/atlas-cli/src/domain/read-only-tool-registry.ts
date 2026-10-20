import type { SecretRedactionSummary, SecretRedactor } from "./secret-redaction.js";
import type {
  ToolCapability,
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
  /** Defaults to "read". Set explicitly for a tool that mutates anything. */
  readonly capability?: ToolCapability;
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
      /** Present only when a redactor is configured, so callers can report what was removed. */
      readonly redaction?: SecretRedactionSummary;
    }
  | {
      readonly status: "approval-required";
      readonly policy: ToolPolicyEvaluation;
    }
  | {
      /**
       * The tool was allowed to run and rejected its input or its `execute` threw — an
       * ordinary domain-level failure (a file that doesn't exist yet, a
       * path outside the repository) rather than a policy or lookup
       * problem. Callers should feed this back to the model as a failed
       * tool result so it can adapt, not treat it as fatal to the session.
       */
      readonly status: "failed";
      readonly policy: ToolPolicyEvaluation;
      readonly message: string;
      readonly errorCode?: string;
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
  /**
   * Optional: when supplied, tool output is scrubbed of credentials before it
   * is returned. This is the last boundary before repository content becomes
   * model context, so it is the one place redaction cannot be skipped by a
   * caller that forgets to ask for it.
   */
  readonly redactor?: SecretRedactor;
}
