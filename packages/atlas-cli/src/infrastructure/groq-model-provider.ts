import type { ModelCapabilities, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { validateModelRequest, validateModelResponse } from "../model/model-contract-validation.js";
import { buildOpenAiChatPayload, parseOpenAiChatResponse } from "./openai-compatible-chat-format.js";

const DEFAULT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface GroqModelProviderOptions {
  readonly apiKey: string;
  readonly models: readonly ModelCapabilities[];
  readonly endpoint?: string | URL;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

/**
 * Calls Groq's real, remote, OpenAI-compatible chat-completions endpoint.
 * Unlike LocalOpenAiCompatibleModelProvider, this is deliberately NOT
 * loopback-restricted — Groq is meant to be called from CI/hosted contexts
 * with full network access, not from the local-first CLI chat path.
 */
export class GroqModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  readonly #apiKey: string;
  readonly #endpoint: URL;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  public constructor(options: GroqModelProviderOptions) {
    if (options.apiKey.trim().length === 0) throw new TypeError("GroqModelProvider requires a non-empty apiKey.");
    this.#apiKey = options.apiKey;
    this.#endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.metadata = { id: "groq", displayName: "Groq", models: [...options.models] };
  }

  public async complete(request: ModelRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ModelResponse> {
    const validated = validateModelRequest(request);
    const payload = buildOpenAiChatPayload(validated);
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (cause) {
      const cancelled = options.signal?.aborted === true;
      throw new ModelProviderError({
        message: cancelled ? "Groq request cancelled" : "Groq request failed",
        code: cancelled ? "cancelled" : "provider-failure",
        providerId: this.metadata.id,
        retryable: !cancelled,
        cause,
      });
    }

    const text = await response.text();
    if (Buffer.byteLength(text) > this.#maxResponseBytes) {
      throw new ModelProviderError({
        message: "Groq response exceeded the configured size limit",
        code: "provider-failure",
        providerId: this.metadata.id,
        retryable: false,
      });
    }
    if (!response.ok) {
      // Groq validates the model's tool calls server-side and answers a call
      // to an unadvertised tool with HTTP 400 instead of returning it. The
      // rejected call comes back verbatim in `failed_generation`, so rather
      // than lose the whole session to one invented name, hand it to the
      // agent as the tool call it is and let the registry answer "no such
      // tool" the way it does for every other provider.
      const recovered = response.status === 400
        ? recoverRejectedToolCall(text, validated.model, this.metadata.id)
        : undefined;
      if (recovered !== undefined) return recovered;

      const authFailure = response.status === 401 || response.status === 403;
      // Groq's error responses (rate limits, oversized requests, invalid
      // models) carry the actual reason in the body; without it every
      // failure looks identical and has to be guessed at from the status
      // code alone.
      const detail = text.trim().slice(0, 500);
      throw new ModelProviderError({
        message: `Groq endpoint returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
        code: authFailure ? "authentication" : response.status === 429 ? "rate-limit" : "provider-failure",
        providerId: this.metadata.id,
        retryable: !authFailure && (response.status === 429 || response.status >= 500),
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new ModelProviderError({
        message: "Groq endpoint returned invalid JSON",
        code: "provider-failure",
        providerId: this.metadata.id,
        retryable: false,
        cause,
      });
    }
    return parseOpenAiChatResponse(parsed, this.metadata.id);
  }
}

/**
 * Rebuilds the tool call Groq refused to return.
 *
 * This reconstructs, it does not invent: the model really did emit this call,
 * and Groq echoes it back in `failed_generation` while declining to deliver it
 * in the normal shape. Anything that is not recognisably a rejected tool call
 * returns undefined so the caller raises the error unchanged.
 */
function recoverRejectedToolCall(body: string, model: string, providerId: string): ModelResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = asRecord(asRecord(parsed)?.["error"]);
  if (error?.["code"] !== "tool_use_failed") return undefined;
  const generation = error["failed_generation"];
  if (typeof generation !== "string") return undefined;

  let call: unknown;
  try {
    call = JSON.parse(generation);
  } catch {
    return undefined;
  }
  const record = asRecord(call);
  if (record === undefined) return undefined;
  const name = record["name"];
  if (typeof name !== "string" || name.length === 0) return undefined;
  const args = asRecord(record["arguments"]) ?? {};

  return validateModelResponse({
    id: `groq-rejected-tool-call:${name}`,
    providerId,
    model,
    message: { role: "assistant", content: [{ type: "tool-call", id: "groq-rejected-tool-call", name, arguments: args }] },
    finishReason: "tool-calls",
    // Groq bills nothing for a rejected generation and reports no usage with
    // it. Reporting zero is accurate; inventing a number would corrupt the
    // session's token accounting.
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
