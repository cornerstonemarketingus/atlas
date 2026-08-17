import type { JsonValue, ModelCapabilities, ModelMessage, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { validateModelRequest, validateModelResponse } from "../model/model-contract-validation.js";
import { BoundedJsonHttpTransport, JsonHttpTransportError } from "./bounded-json-http-transport.js";

export interface LocalOpenAiCompatibleProviderOptions {
  readonly endpoint: URL | string;
  readonly models: readonly ModelCapabilities[];
  readonly providerId?: string;
  readonly displayName?: string;
  readonly transport?: BoundedJsonHttpTransport;
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;

function contentText(content: readonly { readonly type: string; readonly text?: string; readonly value?: JsonValue }[]): string {
  return content.map((part) => part.type === "text" ? part.text ?? "" : JSON.stringify(part.value)).join("\n");
}

function mapMessage(message: ModelMessage): RecordValue {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: contentText(message.content) };
  if (message.role === "assistant") {
    const calls = message.content.filter((part) => part.type === "tool-call").map((part) => ({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments) } }));
    return { role: "assistant", content: contentText(message.content.filter((part) => part.type === "text")), ...(calls.length === 0 ? {} : { tool_calls: calls }) };
  }
  return { role: message.role, content: contentText(message.content) };
}

function parseResponse(value: unknown, providerId: string): ModelResponse {
  const root = object(value);
  const choice = Array.isArray(root?.["choices"]) ? object(root?.["choices"]?.[0]) : undefined;
  const message = object(choice?.["message"]);
  const usage = object(root?.["usage"]);
  const content: Array<Record<string, unknown>> = [];
  if (typeof message?.["content"] === "string" && message["content"].length > 0) content.push({ type: "text", text: message["content"] });
  if (Array.isArray(message?.["tool_calls"])) {
    for (const rawCall of message["tool_calls"]) {
      const call = object(rawCall); const fn = object(call?.["function"]);
      let args: unknown;
      try { args = JSON.parse(typeof fn?.["arguments"] === "string" ? fn["arguments"] : ""); } catch { args = undefined; }
      content.push({ type: "tool-call", id: call?.["id"], name: fn?.["name"], arguments: args });
    }
  }
  const finishMap: Record<string, string> = { stop: "stop", tool_calls: "tool-calls", length: "length", content_filter: "content-filter" };
  const input = usage?.["prompt_tokens"];
  const output = usage?.["completion_tokens"];
  return validateModelResponse({
    id: root?.["id"], providerId, model: root?.["model"], message: { role: "assistant", content },
    finishReason: typeof choice?.["finish_reason"] === "string" ? finishMap[choice["finish_reason"]] ?? "other" : "other",
    usage: { inputTokens: input, outputTokens: output, totalTokens: usage?.["total_tokens"] },
  });
}

export class LocalOpenAiCompatibleModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  private readonly endpoint: URL;
  private readonly transport: BoundedJsonHttpTransport;

  public constructor(options: LocalOpenAiCompatibleProviderOptions) {
    this.endpoint = new URL(options.endpoint);
    this.transport = options.transport ?? new BoundedJsonHttpTransport();
    this.metadata = { id: options.providerId ?? "local-openai-compatible", displayName: options.displayName ?? "Local OpenAI-compatible model", models: [...options.models] };
  }

  public async complete(request: ModelRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ModelResponse> {
    const validated = validateModelRequest(request);
    const payload = {
      model: validated.model, messages: validated.messages.map(mapMessage), stream: false,
      ...(validated.tools === undefined ? {} : { tools: validated.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
      ...(validated.temperature === undefined ? {} : { temperature: validated.temperature }),
      ...(validated.maxOutputTokens === undefined ? {} : { max_tokens: validated.maxOutputTokens }),
      ...(validated.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    };
    try {
      return parseResponse(await this.transport.post(this.endpoint, payload, options), this.metadata.id);
    } catch (cause) {
      if (cause instanceof ModelProviderError) throw cause;
      const cancelled = cause instanceof JsonHttpTransportError && cause.kind === "cancelled";
      const status = cause instanceof JsonHttpTransportError ? cause.statusCode : undefined;
      throw new ModelProviderError({
        message: cancelled ? "Local model request cancelled" : "Local model request failed",
        code: cancelled ? "cancelled" : status === 400 ? "invalid-request" : status === 404 ? "model-unavailable" : status === 429 ? "rate-limit" : "provider-failure",
        providerId: this.metadata.id, retryable: !cancelled && (status === undefined || status === 429 || status >= 500), cause,
      });
    }
  }
}
