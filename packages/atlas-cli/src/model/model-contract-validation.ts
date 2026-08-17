import type {
  AssistantContent,
  AssistantMessage,
  InputContent,
  JsonValue,
  ModelCapabilities,
  ModelMessage,
  ModelProviderMetadata,
  ModelRequest,
  ModelResponse,
  ModelToolDefinition,
  ModelUsage,
} from "./model-provider.js";

export type ModelValidationErrorCode =
  | "invalid-type"
  | "invalid-value"
  | "missing-field"
  | "unknown-field"
  | "limit-exceeded";

export class ModelValidationError extends Error {
  public constructor(
    public readonly path: string,
    public readonly code: ModelValidationErrorCode,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ModelValidationError";
  }
}

const LIMITS = {
  identifier: 256,
  text: 1_000_000,
  messages: 1_000,
  content: 1_000,
  tools: 256,
  models: 1_000,
  jsonDepth: 32,
  jsonNodes: 100_000,
  tokens: 2_147_483_647,
} as const;

type UnknownRecord = Record<string, unknown>;

function fail(path: string, code: ModelValidationErrorCode, message: string): never {
  throw new ModelValidationError(path, code, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "invalid-type", "expected an object");
  }
  return value as UnknownRecord;
}

function exact(value: UnknownRecord, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, "unknown-field", "field is not allowed");
  }
}

function required(value: UnknownRecord, key: string, path: string): unknown {
  if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "missing-field", "field is required");
  return value[key];
}

function string(value: unknown, path: string, max: number = LIMITS.identifier, allowEmpty = false): string {
  if (typeof value !== "string") fail(path, "invalid-type", "expected a string");
  if (!allowEmpty && value.length === 0) fail(path, "invalid-value", "must not be empty");
  if (value.length > max) fail(path, "limit-exceeded", `must contain at most ${max} characters`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "invalid-type", "expected a boolean");
  return value;
}

function finite(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "invalid-type", "expected a finite number");
  if ((integer && !Number.isInteger(value)) || value < min || value > max) {
    fail(path, "invalid-value", `expected ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  }
  return value;
}

function array(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "invalid-type", "expected an array");
  if (value.length > max) fail(path, "limit-exceeded", `must contain at most ${max} items`);
  return value;
}

function json(value: unknown, path: string, state = { nodes: 0 }, depth = 0): JsonValue {
  state.nodes += 1;
  if (state.nodes > LIMITS.jsonNodes) fail(path, "limit-exceeded", "JSON node limit exceeded");
  if (depth > LIMITS.jsonDepth) fail(path, "limit-exceeded", "JSON nesting limit exceeded");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > LIMITS.text) fail(path, "limit-exceeded", "JSON string is too long");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "invalid-value", "JSON numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${path}[${index}]`, state, depth + 1));
  const source = record(value, path);
  // A null prototype prevents special keys such as `__proto__` from mutating
  // the validator's output object while preserving them as ordinary JSON data.
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const [key, item] of Object.entries(source)) {
    if (key.length > LIMITS.identifier) fail(`${path}.${key}`, "limit-exceeded", "JSON key is too long");
    result[key] = json(item, `${path}.${key}`, state, depth + 1);
  }
  return result;
}

function content(value: unknown, path: string, assistant: boolean): InputContent | AssistantContent {
  const item = record(value, path);
  const type = required(item, "type", path);
  if (type === "text") {
    exact(item, ["type", "text"], path);
    return { type, text: string(required(item, "text", path), `${path}.text`, LIMITS.text, true) };
  }
  if (!assistant && type === "json") {
    exact(item, ["type", "value"], path);
    return { type, value: json(required(item, "value", path), `${path}.value`) };
  }
  if (assistant && type === "tool-call") {
    exact(item, ["type", "id", "name", "arguments"], path);
    const args = json(required(item, "arguments", path), `${path}.arguments`);
    if (typeof args !== "object" || args === null || Array.isArray(args)) fail(`${path}.arguments`, "invalid-type", "expected an object");
    return {
      type,
      id: string(required(item, "id", path), `${path}.id`),
      name: string(required(item, "name", path), `${path}.name`),
      arguments: args as Readonly<Record<string, JsonValue>>,
    };
  }
  fail(`${path}.type`, "invalid-value", "unsupported content type");
}

function message(value: unknown, path: string): ModelMessage {
  const item = record(value, path);
  const role = required(item, "role", path);
  const rawContent = array(required(item, "content", path), `${path}.content`, LIMITS.content);
  if (role === "system" || role === "user" || role === "assistant") {
    exact(item, ["role", "content"], path);
    const parsed = rawContent.map((entry, index) => content(entry, `${path}.content[${index}]`, role === "assistant"));
    if (role === "system") {
      if (parsed.some((entry) => entry.type !== "text")) fail(`${path}.content`, "invalid-value", "system content must be text");
      return { role, content: parsed as { readonly type: "text"; readonly text: string }[] };
    }
    if (role === "assistant") return { role, content: parsed as AssistantContent[] };
    return { role, content: parsed as InputContent[] };
  }
  if (role === "tool") {
    exact(item, ["role", "toolCallId", "isError", "content"], path);
    return {
      role,
      toolCallId: string(required(item, "toolCallId", path), `${path}.toolCallId`),
      isError: boolean(required(item, "isError", path), `${path}.isError`),
      content: rawContent.map((entry, index) => content(entry, `${path}.content[${index}]`, false)) as InputContent[],
    };
  }
  fail(`${path}.role`, "invalid-value", "unsupported message role");
}

function tool(value: unknown, path: string): ModelToolDefinition {
  const item = record(value, path);
  exact(item, ["name", "description", "inputSchema"], path);
  const schema = json(required(item, "inputSchema", path), `${path}.inputSchema`);
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) fail(`${path}.inputSchema`, "invalid-type", "expected an object");
  return {
    name: string(required(item, "name", path), `${path}.name`),
    description: string(required(item, "description", path), `${path}.description`, 16_384, true),
    inputSchema: schema as Readonly<Record<string, JsonValue>>,
  };
}

export function validateModelRequest(value: unknown): ModelRequest {
  const item = record(value, "$request");
  exact(item, ["model", "messages", "tools", "temperature", "maxOutputTokens", "responseFormat"], "$request");
  const result: ModelRequest = {
    model: string(required(item, "model", "$request"), "$request.model"),
    messages: array(required(item, "messages", "$request"), "$request.messages", LIMITS.messages)
      .map((entry, index) => message(entry, `$request.messages[${index}]`)),
    ...(item["tools"] === undefined ? {} : { tools: array(item["tools"], "$request.tools", LIMITS.tools).map((entry, index) => tool(entry, `$request.tools[${index}]`)) }),
    ...(item["temperature"] === undefined ? {} : { temperature: finite(item["temperature"], "$request.temperature", 0, 2) }),
    ...(item["maxOutputTokens"] === undefined ? {} : { maxOutputTokens: finite(item["maxOutputTokens"], "$request.maxOutputTokens", 1, LIMITS.tokens, true) }),
    ...(item["responseFormat"] === undefined ? {} : { responseFormat: enumValue(item["responseFormat"], "$request.responseFormat", ["text", "json"] as const) }),
  };
  return result;
}

function enumValue<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(path, "invalid-value", `expected one of: ${allowed.join(", ")}`);
  return value as T;
}

function usage(value: unknown, path: string): ModelUsage {
  const item = record(value, path);
  exact(item, ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "estimatedCostUsd"], path);
  const result: ModelUsage = {
    inputTokens: finite(required(item, "inputTokens", path), `${path}.inputTokens`, 0, LIMITS.tokens, true),
    outputTokens: finite(required(item, "outputTokens", path), `${path}.outputTokens`, 0, LIMITS.tokens, true),
    totalTokens: finite(required(item, "totalTokens", path), `${path}.totalTokens`, 0, LIMITS.tokens, true),
    ...(item["cachedInputTokens"] === undefined ? {} : { cachedInputTokens: finite(item["cachedInputTokens"], `${path}.cachedInputTokens`, 0, LIMITS.tokens, true) }),
    ...(item["estimatedCostUsd"] === undefined ? {} : { estimatedCostUsd: finite(item["estimatedCostUsd"], `${path}.estimatedCostUsd`, 0, 1_000_000) }),
  };
  if (result.totalTokens !== result.inputTokens + result.outputTokens) fail(`${path}.totalTokens`, "invalid-value", "must equal inputTokens plus outputTokens");
  if ((result.cachedInputTokens ?? 0) > result.inputTokens) fail(`${path}.cachedInputTokens`, "invalid-value", "must not exceed inputTokens");
  return result;
}

export function validateModelResponse(value: unknown): ModelResponse {
  const item = record(value, "$response");
  exact(item, ["id", "providerId", "model", "message", "finishReason", "usage"], "$response");
  const parsedMessage = message(required(item, "message", "$response"), "$response.message");
  if (parsedMessage.role !== "assistant") fail("$response.message.role", "invalid-value", "response message must be assistant");
  return {
    id: string(required(item, "id", "$response"), "$response.id"),
    providerId: string(required(item, "providerId", "$response"), "$response.providerId"),
    model: string(required(item, "model", "$response"), "$response.model"),
    message: parsedMessage as AssistantMessage,
    finishReason: enumValue(required(item, "finishReason", "$response"), "$response.finishReason", ["stop", "tool-calls", "length", "content-filter", "cancelled", "error", "other"] as const),
    usage: usage(required(item, "usage", "$response"), "$response.usage"),
  };
}

function capabilities(value: unknown, path: string): ModelCapabilities {
  const item = record(value, path);
  exact(item, ["model", "contextWindowTokens", "maxOutputTokens", "supportsTools", "supportsJson", "supportsStreaming"], path);
  const result: ModelCapabilities = {
    model: string(required(item, "model", path), `${path}.model`),
    contextWindowTokens: finite(required(item, "contextWindowTokens", path), `${path}.contextWindowTokens`, 1, LIMITS.tokens, true),
    maxOutputTokens: finite(required(item, "maxOutputTokens", path), `${path}.maxOutputTokens`, 1, LIMITS.tokens, true),
    supportsTools: boolean(required(item, "supportsTools", path), `${path}.supportsTools`),
    supportsJson: boolean(required(item, "supportsJson", path), `${path}.supportsJson`),
    supportsStreaming: boolean(required(item, "supportsStreaming", path), `${path}.supportsStreaming`),
  };
  if (result.maxOutputTokens > result.contextWindowTokens) fail(`${path}.maxOutputTokens`, "invalid-value", "must not exceed contextWindowTokens");
  return result;
}

export function validateModelProviderMetadata(value: unknown): ModelProviderMetadata {
  const item = record(value, "$metadata");
  exact(item, ["id", "displayName", "models"], "$metadata");
  const models = array(required(item, "models", "$metadata"), "$metadata.models", LIMITS.models)
    .map((entry, index) => capabilities(entry, `$metadata.models[${index}]`));
  if (new Set(models.map((model) => model.model)).size !== models.length) fail("$metadata.models", "invalid-value", "model names must be unique");
  return {
    id: string(required(item, "id", "$metadata"), "$metadata.id"),
    displayName: string(required(item, "displayName", "$metadata"), "$metadata.displayName", 1_024),
    models,
  };
}
