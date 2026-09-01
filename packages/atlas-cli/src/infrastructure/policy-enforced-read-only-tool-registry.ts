import {
  ReadOnlyToolRegistryError,
  type ReadOnlyToolContext,
  type ReadOnlyToolDefinition,
  type ReadOnlyToolExecutionRequest,
  type ReadOnlyToolExecutionResult,
  type ReadOnlyToolRegistry,
  type ReadOnlyToolRegistryOptions,
} from "../domain/read-only-tool-registry.js";
import { summarizeRedaction } from "../domain/secret-redaction.js";
import { evaluateToolPolicy, type ToolPolicyEvaluation } from "../domain/tool-policy.js";

interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly risk: ReadOnlyToolDefinition<unknown, unknown>["risk"];
  readonly capability: NonNullable<ReadOnlyToolDefinition<unknown, unknown>["capability"]>;
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
      capability: definition.capability ?? "read",
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
      capability: definition.capability,
      risk: definition.risk,
      scope: request.scope,
    });
    if (policy.decision === "deny") {
      throw new ReadOnlyToolRegistryError("POLICY_DENIED", `Policy denied tool: ${request.name}`);
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

    let output: unknown;
    try {
      output = await definition.execute(validatedInput, request.context);
    } catch (error: unknown) {
      // A tool that passed policy and then threw during its own execution
      // is an ordinary domain failure (missing file, path outside the
      // repository) that the model should see and adapt to — not the same
      // class of problem as a policy or lookup error above, which still
      // ends the session.
      //
      // The message is redacted like any other output, because a failure
      // string routinely quotes the very content that caused it ("could not
      // parse ...", "unexpected token in AKIA...").
      const raw = error instanceof Error ? error.message : "Tool execution failed.";
      const rawCode = (error as { code?: unknown } | null)?.code;
      const errorCode = typeof rawCode === "string" ? rawCode : undefined;
      const message = await this.#redactText(raw);
      return { status: "failed", policy, message, ...(errorCode === undefined ? {} : { errorCode }) };
    }

    // Redacting the success path happens outside that catch on purpose: a
    // fault in the redactor itself is an Atlas-internal problem and must fail
    // closed, not be reported to the model as a tool failure it might try to
    // route around.
    return await this.#complete(output, policy);
  }

  async #redactText(text: string): Promise<string> {
    const redactor = this.options.redactor;
    return redactor === undefined ? text : (await redactor.redact(text)).text;
  }

  /**
   * Redacts the serialized output rather than walking the object graph: every
   * consumer serializes this value into the model transcript anyway, so
   * scrubbing the exact bytes that leave the process is what actually matters.
   */
  async #complete(
    output: unknown,
    policy: ToolPolicyEvaluation,
  ): Promise<ReadOnlyToolExecutionResult> {
    const redactor = this.options.redactor;
    if (redactor === undefined) return { status: "completed", output, policy };
    const serialized = JSON.stringify(output);
    // `undefined` output has no serialized form and so carries nothing to leak.
    if (serialized === undefined) return { status: "completed", output, policy };

    const result = await redactor.redact(serialized);
    const redaction = summarizeRedaction(result);
    if (result.redactionCount === 0 && !result.truncated) {
      return { status: "completed", output, policy, redaction };
    }
    return { status: "completed", output: reviveRedactedOutput(result.text), policy, redaction };
  }
}

/**
 * Placeholders are plain text and keep the JSON well-formed, but a bounded scan
 * can drop the tail mid-document. Handing back the redacted text as a string is
 * a lossy but safe fallback; re-serializing the original object would undo the
 * redaction.
 */
function reviveRedactedOutput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
