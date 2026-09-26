import { createHash } from "node:crypto";

/**
 * A provider-neutral tool registry with capability-based policy.
 *
 * Two rules shape everything here. The model may only invoke a tool that was
 * registered, and it may only invoke it with arguments that validate — both
 * fail closed, because an agent that can call an unknown name or pass an
 * unchecked object is an agent whose blast radius is whatever the runtime
 * happens to expose.
 *
 * Credentials are referenced, never carried. A tool declares the *names* of
 * the secrets it needs; the registry resolves them at call time from a vault
 * the model never sees, and the values never appear in a schema, a prompt, an
 * argument, a receipt, or an error.
 */
export const TOOL_RISKS = ["low", "moderate", "high", "critical"];
export const POLICY_DECISIONS = ["allow", "ask", "deny"];

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

/**
 * Deliberately a small subset of JSON Schema rather than a dependency: the
 * local control plane must stay installable without an npm registry, and a
 * validator the agent's inputs flow through is not somewhere to accept a
 * supply-chain risk for convenience.
 */
export function validateAgainstSchema(schema, value, path = "input") {
  if (!schema || typeof schema !== "object") throw new ToolError("BAD_SCHEMA", `${path} has no schema.`);
  const type = schema.type;

  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ToolError("INVALID_INPUT", `${path} must be an object.`);
    for (const required of schema.required ?? []) {
      if (!(required in value)) throw new ToolError("INVALID_INPUT", `${path}.${required} is required.`);
    }
    const properties = schema.properties ?? {};
    // Unknown properties are refused rather than ignored: a silently dropped
    // argument is a tool doing something other than what was approved.
    for (const key of Object.keys(value)) {
      if (!(key in properties)) throw new ToolError("INVALID_INPUT", `${path}.${key} is not an accepted argument.`);
    }
    const out = {};
    for (const [key, sub] of Object.entries(properties)) {
      if (key in value) out[key] = validateAgainstSchema(sub, value[key], `${path}.${key}`);
      else if ("default" in sub) out[key] = sub.default;
    }
    return out;
  }

  if (type === "array") {
    if (!Array.isArray(value)) throw new ToolError("INVALID_INPUT", `${path} must be an array.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ToolError("INVALID_INPUT", `${path} accepts at most ${schema.maxItems} items.`);
    return value.map((entry, index) => validateAgainstSchema(schema.items, entry, `${path}[${index}]`));
  }

  if (type === "string") {
    if (typeof value !== "string") throw new ToolError("INVALID_INPUT", `${path} must be a string.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new ToolError("INVALID_INPUT", `${path} must be at most ${schema.maxLength} characters.`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new ToolError("INVALID_INPUT", `${path} must be at least ${schema.minLength} characters.`);
    if (schema.enum && !schema.enum.includes(value)) throw new ToolError("INVALID_INPUT", `${path} must be one of: ${schema.enum.join(", ")}.`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) throw new ToolError("INVALID_INPUT", `${path} is not in the accepted format.`);
    return value;
  }

  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError("INVALID_INPUT", `${path} must be a number.`);
    if (type === "integer" && !Number.isInteger(value)) throw new ToolError("INVALID_INPUT", `${path} must be an integer.`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new ToolError("INVALID_INPUT", `${path} must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ToolError("INVALID_INPUT", `${path} must be at most ${schema.maximum}.`);
    return value;
  }

  if (type === "boolean") {
    if (typeof value !== "boolean") throw new ToolError("INVALID_INPUT", `${path} must be true or false.`);
    return value;
  }

  throw new ToolError("BAD_SCHEMA", `${path} declares an unsupported schema type: ${String(type)}.`);
}

/**
 * The digest an approval is bound to.
 *
 * It covers the tool, the exact validated arguments, and the session — so an
 * approval for "delete record A" cannot be replayed against "delete record B",
 * and an approval granted in one session cannot be spent in another.
 */
export function actionDigest({ sessionId, tool, input }) {
  return createHash("sha256")
    .update(JSON.stringify({ sessionId, tool, input: canonicalize(input) }))
    .digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function requireDeclaration(definition) {
  const problems = [];
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u.test(definition.name ?? "")) problems.push("a dotted lowercase name");
  if (!definition.description) problems.push("a description");
  if (!definition.capability) problems.push("a capability identifier");
  if (!TOOL_RISKS.includes(definition.risk)) problems.push(`a risk from ${TOOL_RISKS.join("/")}`);
  if (!definition.inputSchema || definition.inputSchema.type !== "object") problems.push("an object input schema");
  if (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0) problems.push("a positive timeoutMs");
  if (!Number.isFinite(definition.maxOutputCharacters) || definition.maxOutputCharacters <= 0) problems.push("a positive maxOutputCharacters");
  if (typeof definition.requiresApproval !== "boolean") problems.push("an explicit requiresApproval");
  if (typeof definition.execute !== "function") problems.push("an execute function");
  if (problems.length > 0) {
    throw new ToolError("INCOMPLETE_DECLARATION", `Tool '${definition.name ?? "(unnamed)"}' must declare ${problems.join(", ")}.`);
  }
}

export class ToolRegistry {
  #tools = new Map();
  #policy;
  #secrets;
  #redact;

  /**
   * @param policy capability -> "allow" | "ask" | "deny". A capability with no
   *   entry is denied: a tool family nobody has ruled on does not get a pass.
   * @param secrets name -> value lookup. Only ever called inside execute().
   */
  constructor({ policy = () => "deny", secrets = () => null, redact = (text) => text } = {}) {
    this.#policy = policy;
    this.#secrets = secrets;
    this.#redact = redact;
  }

  register(definition) {
    requireDeclaration(definition);
    if (this.#tools.has(definition.name)) throw new ToolError("DUPLICATE_TOOL", `Tool '${definition.name}' is already registered.`);
    this.#tools.set(definition.name, {
      retries: 0,
      credentials: [],
      ...definition,
    });
    return this;
  }

  has(name) { return this.#tools.has(name); }
  get(name) { return this.#tools.get(name) ?? null; }
  list() {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      capability: tool.capability,
      risk: tool.risk,
      requiresApproval: tool.requiresApproval,
    }));
  }

  /** The tool definitions offered to the model. Never includes credentials. */
  toModelTools() {
    return [...this.#tools.values()].map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
  }

  /**
   * Validates, checks policy, and runs one tool call.
   *
   * Returns a discriminated result rather than throwing for ordinary
   * failures: a tool that fails is information the model should get back and
   * adapt to, not the end of the session.
   */
  async invoke({ name, rawArguments, sessionId, signal, approvals = null, context = {} }) {
    const tool = this.#tools.get(name);
    if (!tool) return { status: "rejected", code: "UNKNOWN_TOOL", message: `There is no tool named '${name}'.` };

    let input;
    try {
      const parsed = typeof rawArguments === "string" ? JSON.parse(rawArguments || "{}") : (rawArguments ?? {});
      input = validateAgainstSchema(tool.inputSchema, parsed);
    } catch (error) {
      const message = error instanceof ToolError ? error.message : `Arguments for '${name}' are not valid JSON.`;
      return { status: "rejected", code: "INVALID_INPUT", message };
    }

    const decision = this.#policy(tool.capability, tool.risk);
    if (decision === "deny") {
      return { status: "rejected", code: "POLICY_DENIED", message: `Local policy denies the capability '${tool.capability}'.`, input };
    }

    const digest = actionDigest({ sessionId, tool: name, input });
    if (tool.requiresApproval || decision === "ask") {
      const granted = approvals ? await approvals.check(digest) : false;
      if (!granted) {
        return { status: "approval-required", code: "APPROVAL_REQUIRED", digest, input, capability: tool.capability, risk: tool.risk };
      }
    }

    const credentials = {};
    for (const reference of tool.credentials) {
      const value = await this.#secrets(reference);
      if (value === null || value === undefined) {
        return { status: "rejected", code: "MISSING_CREDENTIAL", message: `This tool needs the credential '${reference}', which is not configured on this machine.`, input };
      }
      credentials[reference] = value;
    }

    const attempts = tool.retries + 1;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const output = await withTimeout(tool.execute({ input, credentials, signal, context, digest }), tool.timeoutMs, signal, name);
        return { status: "completed", output: this.#bound(tool, output), digest, input };
      } catch (error) {
        lastError = error;
        // An input or authorization failure will fail identically next time;
        // only genuinely transient failures are worth another attempt.
        if (error?.code === "INVALID_INPUT" || error?.code === "NOT_AUTHORIZED" || attempt === attempts) break;
      }
    }
    return {
      status: "failed",
      code: lastError?.code ?? "TOOL_FAILED",
      message: this.#redact(lastError instanceof Error ? lastError.message : "The tool failed."),
      digest,
      input,
    };
  }

  /** Bounds and redacts output before it can become model context or a receipt. */
  #bound(tool, output) {
    const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
    const redacted = this.#redact(text);
    return redacted.length > tool.maxOutputCharacters
      ? `${redacted.slice(0, tool.maxOutputCharacters)}\n…[output truncated at ${tool.maxOutputCharacters} characters]`
      : redacted;
  }
}

function withTimeout(promise, timeoutMs, signal, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new ToolError("TOOL_TIMEOUT", `Tool '${name}' exceeded its ${timeoutMs}ms timeout.`);
      reject(error);
    }, timeoutMs);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new ToolError("TOOL_CANCELLED", `Tool '${name}' was cancelled.`)); };
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
