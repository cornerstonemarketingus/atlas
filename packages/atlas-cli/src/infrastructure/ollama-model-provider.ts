import type { JsonValue, ModelCapabilities, ModelMessage, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { validateModelRequest, validateModelResponse } from "../model/model-contract-validation.js";
import { boundCoderContext } from "../model/bounded-coder-context.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434/api/chat";
// A 1.5B model took 67 s for a 3,026-token prompt on a CPU laptop; a minute is
// not a hang there. Cancellation is the operator's call, not a short timer.
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// Code and JSON tokenise at roughly three bytes per token. Over-estimating only
// trims older re-readable tool output sooner; under-estimating lets Ollama drop
// the start of the prompt without saying so.
const BYTES_PER_TOKEN_ESTIMATE = 3;
// Ollama keeps the newest tokens when a prompt overflows num_ctx. A prompt that
// reports this close to the window was cut.
const TRUNCATION_MARGIN_TOKENS = 16;

export interface OllamaModelProviderOptions {
  readonly models: readonly ModelCapabilities[];
  /** `http://127.0.0.1:11434` or the full `/api/chat` URL. */
  readonly endpoint?: string | URL;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

/**
 * The native Ollama chat API (`/api/chat`), as its own provider rather than an
 * OpenAI-compatible client labelled "groq".
 *
 * The reason to prefer it is the context window. Ollama's `/v1` endpoint cannot
 * be told a window: the server's default applies, and a longer prompt loses its
 * head without an error. The native API takes `options.num_ctx` and
 * `options.num_predict` per request, reports `prompt_eval_count`, and so lets
 * this provider (1) trim the request to the declared window before sending,
 * (2) ask for exactly that window, and (3) refuse a response whose prompt count
 * shows the server cut it anyway. A confident answer to half a prompt is worse
 * than an error.
 *
 * Keyless, and loopback or https only: a prompt carries repository content.
 */
export class OllamaModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  readonly #endpoint: URL;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;
  #calls = 0;

  public constructor(options: OllamaModelProviderOptions) {
    if (options.models.length === 0) throw new TypeError("OllamaModelProvider needs at least one declared model.");
    this.#endpoint = resolveOllamaChatUrl(options.endpoint ?? DEFAULT_ENDPOINT);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.metadata = { id: "ollama", displayName: "Ollama (local)", models: [...options.models] };
  }

  public async complete(request: ModelRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ModelResponse> {
    const validated = validateModelRequest(request);
    const capabilities = this.metadata.models.find((model) => model.model === validated.model);
    if (capabilities === undefined) {
      throw new ModelProviderError({ message: `Ollama model '${validated.model}' is not declared for this session.`, code: "model-unavailable", providerId: this.metadata.id, retryable: false });
    }
    const numCtx = capabilities.contextWindowTokens;
    const numPredict = Math.min(validated.maxOutputTokens ?? capabilities.maxOutputTokens, capabilities.maxOutputTokens);
    const promptBudgetTokens = numCtx - numPredict;
    if (promptBudgetTokens < 1) {
      throw new ModelProviderError({ message: "The output limit leaves no room for a prompt in the declared context window.", code: "invalid-request", providerId: this.metadata.id, retryable: false });
    }
    const bounded = boundCoderContext({ ...validated, maxOutputTokens: numPredict }, promptBudgetTokens * BYTES_PER_TOKEN_ESTIMATE);
    if (bounded === undefined) {
      throw new ModelProviderError({
        message: `The request does not fit the ${numCtx}-token context window even after trimming re-readable tool output; raise --context-window or give a smaller objective.`,
        code: "invalid-request", providerId: this.metadata.id, retryable: false,
      });
    }

    const body = JSON.stringify(buildOllamaPayload(bounded, numCtx, numPredict));
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, signal });
    } catch (cause) {
      const cancelled = options.signal?.aborted === true;
      throw new ModelProviderError({
        message: cancelled ? "Ollama request cancelled" : "Ollama request failed; is Ollama running at the configured address?",
        code: cancelled ? "cancelled" : "provider-failure", providerId: this.metadata.id, retryable: !cancelled, cause,
      });
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > this.#maxResponseBytes) {
      throw new ModelProviderError({ message: "Ollama response exceeded the configured size limit", code: "provider-failure", providerId: this.metadata.id, retryable: false });
    }
    if (!response.ok) {
      // Provider bodies can echo the prompt; classify, never repeat.
      const status = response.status;
      throw new ModelProviderError({
        message: `Ollama returned HTTP ${status}${status === 404 ? " (model not installed? run: ollama pull <model>)" : ""}`,
        code: status === 404 ? "model-unavailable" : status === 400 ? "invalid-request" : "provider-failure",
        providerId: this.metadata.id, retryable: status >= 500 || status === 429,
      });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (cause) {
      throw new ModelProviderError({ message: `Ollama returned invalid JSON (${Buffer.byteLength(text)} bytes)`, code: "provider-failure", providerId: this.metadata.id, retryable: false, cause });
    }
    return this.#parse(parsed, bounded, numCtx);
  }

  #parse(value: unknown, sent: ModelRequest, numCtx: number): ModelResponse {
    const root = record(value);
    if (typeof root?.["error"] === "string") {
      throw new ModelProviderError({ message: "Ollama reported an error for this request", code: "provider-failure", providerId: this.metadata.id, retryable: false });
    }
    const message = record(root?.["message"]);
    const content: Array<Record<string, unknown>> = [];
    if (typeof message?.["content"] === "string" && message["content"].length > 0) content.push({ type: "text", text: message["content"] });
    const callBatch = ++this.#calls;
    const rawCalls = Array.isArray(message?.["tool_calls"]) ? message["tool_calls"] as unknown[] : [];
    rawCalls.forEach((rawCall, index) => {
      const fn = record(record(rawCall)?.["function"]);
      let args: unknown = fn?.["arguments"];
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = undefined; } }
      content.push({ type: "tool-call", id: `ollama-${callBatch}-${index}`, name: fn?.["name"], arguments: record(args) });
    });

    const reportedPrompt = root?.["prompt_eval_count"];
    const promptTokens = typeof reportedPrompt === "number" && Number.isSafeInteger(reportedPrompt) && reportedPrompt >= 0
      ? reportedPrompt : Math.ceil(Buffer.byteLength(JSON.stringify(sent)) / BYTES_PER_TOKEN_ESTIMATE);
    // Only a reported count can prove truncation; an estimate never fails a run.
    if (typeof reportedPrompt === "number" && reportedPrompt >= numCtx - TRUNCATION_MARGIN_TOKENS) {
      throw new ModelProviderError({
        message: `Ollama filled the ${numCtx}-token context window with the prompt, so the start of it was probably dropped. Refusing to use the answer.`,
        code: "invalid-request", providerId: this.metadata.id, retryable: false,
      });
    }
    const evalCount = root?.["eval_count"];
    const outputTokens = typeof evalCount === "number" && Number.isSafeInteger(evalCount) && evalCount >= 0 ? evalCount : 0;
    const done = root?.["done_reason"];
    const finishReason = rawCalls.length > 0 ? "tool-calls" : done === "length" ? "length" : done === "stop" || done === undefined ? "stop" : "other";
    return validateModelResponse({
      id: `ollama-${callBatch}`,
      providerId: this.metadata.id,
      model: typeof root?.["model"] === "string" ? root["model"] : sent.model,
      message: { role: "assistant", content },
      finishReason,
      usage: { inputTokens: promptTokens, outputTokens, totalTokens: promptTokens + outputTokens },
    });
  }
}

/** Accepts the server origin, an OpenAI-style `/v1` base, or the full `/api/chat` URL. */
export function resolveOllamaChatUrl(raw: string | URL): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new TypeError("An Ollama endpoint must be https, or http on loopback.");
  }
  if (url.username || url.password || url.search || url.hash) throw new TypeError("An Ollama endpoint must not carry credentials, a query or a fragment.");
  const path = url.pathname.replace(/\/+$/u, "").replace(/\/v1(\/chat\/completions)?$/u, "").replace(/\/api\/chat$/u, "");
  url.pathname = `${path}/api/chat`;
  return url;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1" || hostname.endsWith(".localhost");
}

export function buildOllamaPayload(request: ModelRequest, numCtx: number, numPredict: number): Record<string, unknown> {
  const names = new Map<string, string>();
  for (const message of request.messages) {
    if (message.role === "assistant") for (const part of message.content) if (part.type === "tool-call") names.set(part.id, part.name);
  }
  return {
    model: request.model,
    messages: request.messages.map((message) => mapMessage(message, names)),
    stream: false,
    options: { num_ctx: numCtx, num_predict: numPredict, ...(request.temperature === undefined ? {} : { temperature: request.temperature }) },
    ...(request.tools === undefined ? {} : { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
    ...(request.responseFormat === "json" ? { format: "json" } : {}),
  };
}

function text(content: readonly { readonly type: string; readonly text?: string; readonly value?: JsonValue }[]): string {
  return content.map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part.value))).join("\n");
}

function mapMessage(message: ModelMessage, names: ReadonlyMap<string, string>): Record<string, unknown> {
  if (message.role === "tool") {
    const name = names.get(message.toolCallId);
    return { role: "tool", ...(name === undefined ? {} : { tool_name: name }), content: text(message.content) };
  }
  if (message.role === "assistant") {
    const calls = message.content.filter((part) => part.type === "tool-call")
      .map((part) => ({ function: { name: part.name, arguments: part.arguments } }));
    return { role: "assistant", content: text(message.content.filter((part) => part.type === "text")), ...(calls.length === 0 ? {} : { tool_calls: calls }) };
  }
  return { role: message.role, content: text(message.content) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
