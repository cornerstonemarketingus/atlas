import type { JsonValue, ModelMessage, ModelRequest, ModelResponse } from "../model/model-provider.js";
import { validateModelResponse } from "../model/model-contract-validation.js";

type RecordValue = Record<string, unknown>;

const object = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;

function contentText(content: readonly { readonly type: string; readonly text?: string; readonly value?: JsonValue }[]): string {
  return content.map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part.value))).join("\n");
}

function mapMessage(message: ModelMessage): RecordValue {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: contentText(message.content) };
  if (message.role === "assistant") {
    const calls = message.content
      .filter((part) => part.type === "tool-call")
      .map((part) => ({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments) } }));
    return {
      role: "assistant",
      content: contentText(message.content.filter((part) => part.type === "text")),
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
    };
  }
  return { role: message.role, content: contentText(message.content) };
}

/** Builds an OpenAI-compatible chat-completions request body from a validated ModelRequest. */
export function buildOpenAiChatPayload(request: ModelRequest): RecordValue {
  return {
    model: request.model,
    messages: request.messages.map(mapMessage),
    stream: false,
    ...(request.tools === undefined
      ? {}
      : { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
    ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
  };
}

/** Parses and validates an OpenAI-compatible chat-completions response body. */
export function parseOpenAiChatResponse(value: unknown, providerId: string): ModelResponse {
  const root = object(value);
  const choice = Array.isArray(root?.["choices"]) ? object(root?.["choices"]?.[0]) : undefined;
  const message = object(choice?.["message"]);
  const usage = object(root?.["usage"]);
  const content: Array<Record<string, unknown>> = [];
  if (typeof message?.["content"] === "string" && message["content"].length > 0) content.push({ type: "text", text: message["content"] });
  if (Array.isArray(message?.["tool_calls"])) {
    for (const rawCall of message["tool_calls"]) {
      const call = object(rawCall);
      const fn = object(call?.["function"]);
      let args: unknown;
      try {
        args = JSON.parse(typeof fn?.["arguments"] === "string" ? fn["arguments"] : "");
      } catch {
        args = undefined;
      }
      content.push({ type: "tool-call", id: call?.["id"], name: fn?.["name"], arguments: args });
    }
  }
  const finishMap: Record<string, string> = { stop: "stop", tool_calls: "tool-calls", length: "length", content_filter: "content-filter" };
  const input = usage?.["prompt_tokens"];
  const output = usage?.["completion_tokens"];
  return validateModelResponse({
    id: root?.["id"],
    providerId,
    model: root?.["model"],
    message: { role: "assistant", content },
    finishReason: typeof choice?.["finish_reason"] === "string" ? finishMap[choice["finish_reason"]] ?? "other" : "other",
    usage: { inputTokens: input, outputTokens: output, totalTokens: usage?.["total_tokens"] },
  });
}
