import {
  ReadOnlyToolRegistryError,
  type ReadOnlyToolContext,
  type ReadOnlyToolDefinition,
  type ReadOnlyToolExecutionRequest,
  type ReadOnlyToolExecutionResult,
  type ReadOnlyToolRegistry,
  type ReadOnlyToolRegistryOptions,
} from "../domain/read-only-tool-registry.js";
import { evaluateToolPolicy } from "../domain/tool-policy.js";

interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly risk: ReadOnlyToolDefinition<unknown, unknown>["risk"];
  readonly validateInput: (input: unknown) => unknown;
  readonly execute: (input: unknown, context: ReadOnlyToolContext) => Promise<unknown>;
}

export class PolicyEnforcedReadOnlyToolRegistry implements ReadOnlyToolRegistry {
  readonly #definitions = new Map<string, StoredToolDefinition>();

  public constructor(private readonly options: ReadOnlyToolRegistryOptions) {}

  public register<TInput, TOutput>(definition: ReadOnlyToolDefinition<TInput, TOutput>): void {
    const name = definition.name.trim();
    if (name.length === 0) {
      throw new ReadOnlyToolRegistryError("EMPTY_TOOL_NAME", "Tool names must not be empty.");
    }
    if (this.#definitions.has(name)) {
      throw new ReadOnlyToolRegistryError("DUPLICATE_TOOL", `Tool is already registered: ${name}`);
    }
    this.#definitions.set(name, {
      name,
      description: definition.description,
      risk: definition.risk,
      validateInput: definition.validateInput,
      execute: async (input, context) => definition.execute(input as TInput, context),
    });
  }

  public list(): readonly Pick<StoredToolDefinition, "name" | "description" | "risk">[] {
    return [...this.#definitions.values()]
      .map(({ name, description, risk }) => ({ name, description, risk }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async execute(request: ReadOnlyToolExecutionRequest): Promise<ReadOnlyToolExecutionResult> {
    const definition = this.#definitions.get(request.name);
    if (definition === undefined) {
      throw new ReadOnlyToolRegistryError("TOOL_NOT_FOUND", `Unknown read-only tool: ${request.name}`);
    }
    if (request.scope.kind !== "global" && request.scope.repositoryId !== request.context.repositoryId) {
      throw new ReadOnlyToolRegistryError(
        "SCOPE_MISMATCH",
        "Tool scope does not match the execution repository.",
      );
    }
    const policy = evaluateToolPolicy(this.options.policy, {
      capability: "read",
      risk: definition.risk,
      scope: request.scope,
    });
    if (policy.decision === "deny") {
      throw new ReadOnlyToolRegistryError("POLICY_DENIED", `Policy denied read-only tool: ${request.name}`);
    }
    if (policy.decision === "ask") {
      return { status: "approval-required", policy };
    }
    if (request.context.signal?.aborted === true) {
      throw request.context.signal.reason instanceof Error
        ? request.context.signal.reason
        : new Error("Tool execution was cancelled.");
    }
    const validatedInput = definition.validateInput(request.input);
    const output = await definition.execute(validatedInput, request.context);
    return { status: "completed", output, policy };
  }
}
