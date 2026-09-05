import type {
  AssistantContent,
  InputContent,
  ModelFinishReason,
  ModelRequest,
  ModelResponse,
} from "../model/model-provider.js";
import { validateModelResponse } from "../model/model-contract-validation.js";

type RecordValue = Record<string, unknown>;

/** The Anthropic Messages API requires this header on every request. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Anthropic requires `max_tokens` on every request while the neutral contract
 * treats `maxOutputTokens` as optional, so a bounded default stands in when the
 * caller omits it. 16k keeps a non-streaming request comfortably inside the
 * default HTTP timeout; the ceiling matches the documented 128k output cap of
 * the current Claude models.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
export const MAX_OUTPUT_TOKENS_CEILING = 128_000;

/**
 * The Messages API has no schema-free "return JSON" switch equivalent to
 * OpenAI's `response_format: json_object`, so a neutral `responseFormat: "json"`
 * is carried as a system instruction. This is best-effort, not enforced.
 */
export const JSON_RESPONSE_INSTRUCTION =
  "Respond with a single valid JSON value and no surrounding prose, Markdown, or code fences.";

const object = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;

/** Flattens neutral input content into a single text run; JSON parts are serialised. */
function inputText(content: readonly InputContent[]): string {
  return content.map((part) => (part.type === "text" ? part.text : JSON.stringify(part.value))).join("\n");
}

/**
 * Assistant tool calls are `tool_use` content blocks carrying a structured
 * `input` object — not an OpenAI-style `tool_calls` array with JSON-encoded
 * `arguments` — so the arguments object is passed through unserialised.
 */
function assistantBlocks(content: readonly AssistantContent[]): RecordValue[] {
  const blocks: RecordValue[] = [];
  for (const part of content) {
    if (part.type === "text") {
      // The API rejects empty text blocks, so they are dropped rather than sent.
      if (part.text.length > 0) blocks.push({ type: "text", text: part.text });
      continue;
    }
    blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments });
  }
  return blocks;
}

export interface AnthropicPayloadOptions {
  /** Used when the request omits `maxOutputTokens`. Defaults to DEFAULT_MAX_OUTPUT_TOKENS. */
  readonly defaultMaxOutputTokens?: number;
}

/**
 * Builds an Anthropic Messages request body from a validated ModelRequest.
 *
 * Three shape differences from the OpenAI-compatible format are handled here:
 * system messages are hoisted to the top-level `system` parameter, tool results
 * become `tool_result` blocks inside a `user` message (consecutive results are
 * batched into one message, as the API requires), and `max_tokens` is always
 * populated because Anthropic rejects requests without it.
 */
export function buildAnthropicMessagesPayload(
  request: ModelRequest,
  options: AnthropicPayloadOptions = {},
): RecordValue {
  const systemTexts: string[] = [];
  const messages: RecordValue[] = [];
  let pendingToolResults: RecordValue[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    messages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of request.messages) {
    if (message.role === "system") {
      const text = inputText(message.content);
      if (text.length > 0) systemTexts.push(text);
      continue;
    }
    if (message.role === "tool") {
      const text = inputText(message.content);
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        ...(text.length === 0 ? {} : { content: text }),
        ...(message.isError ? { is_error: true } : {}),
      });
      continue;
    }
    flushToolResults();
    if (message.role === "user") {
      const text = inputText(message.content);
      if (text.length > 0) messages.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }
    const blocks = assistantBlocks(message.content);
    if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
  }
  flushToolResults();

  if (request.responseFormat === "json") systemTexts.push(JSON_RESPONSE_INSTRUCTION);
  const system = systemTexts.join("\n\n");

  const requested = request.maxOutputTokens ?? options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxTokens = Math.min(Math.max(1, Math.trunc(requested)), MAX_OUTPUT_TOKENS_CEILING);

  return {
    model: request.model,
    max_tokens: maxTokens,
    messages,
    ...(system.length === 0 ? {} : { system }),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description.length === 0 ? {} : { description: tool.description }),
            input_schema: tool.inputSchema,
          })),
        }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
}

/**
 * Anthropic stop reasons do not line up one-for-one with the neutral union.
 * `stop_sequence` is a natural stop, `refusal` is the closest thing the API has
 * to a content filter, and `pause_turn` (a resumable server-tool pause) has no
 * neutral equivalent at all, so it is the only value that maps to "other".
 */
const FINISH_REASONS: Readonly<Record<string, ModelFinishReason>> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool-calls",
  refusal: "content-filter",
  pause_turn: "other",
};

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Parses and validates an Anthropic Messages API response body. */
export function parseAnthropicMessagesResponse(value: unknown, providerId: string): ModelResponse {
  const root = object(value);
  const rawContent = root?.["content"];
  const blocks = Array.isArray(rawContent) ? rawContent : [];
  const content: RecordValue[] = [];
  for (const rawBlock of blocks) {
    const block = object(rawBlock);
    const type = block?.["type"];
    if (type === "text") {
      const text = block?.["text"];
      if (typeof text === "string" && text.length > 0) content.push({ type: "text", text });
      continue;
    }
    // `thinking`, `redacted_thinking` and server-tool result blocks carry no
    // neutral representation and are deliberately dropped.
    if (type === "tool_use") {
      content.push({ type: "tool-call", id: block?.["id"], name: block?.["name"], arguments: block?.["input"] });
    }
  }

  const stopReason = root?.["stop_reason"];
  const usage = object(root?.["usage"]);
  // Anthropic reports `input_tokens` exclusive of cached tokens, while the
  // neutral contract requires cachedInputTokens <= inputTokens and
  // totalTokens === inputTokens + outputTokens, so the cache counters are
  // folded back into the input total.
  const cacheRead = count(usage?.["cache_read_input_tokens"]);
  const cacheCreation = count(usage?.["cache_creation_input_tokens"]);
  const rawInput = usage?.["input_tokens"];
  const rawOutput = usage?.["output_tokens"];
  const inputTokens = typeof rawInput === "number" ? rawInput + cacheRead + cacheCreation : rawInput;
  const totalTokens =
    typeof inputTokens === "number" && typeof rawOutput === "number" ? inputTokens + rawOutput : undefined;

  return validateModelResponse({
    id: root?.["id"],
    providerId,
    model: root?.["model"],
    message: { role: "assistant", content },
    finishReason: typeof stopReason === "string" ? FINISH_REASONS[stopReason] ?? "other" : "other",
    usage: {
      inputTokens,
      outputTokens: rawOutput,
      totalTokens,
      ...(cacheRead === 0 ? {} : { cachedInputTokens: cacheRead }),
    },
  });
}
