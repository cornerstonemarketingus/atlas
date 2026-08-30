import type { ModelCapabilities, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { validateModelRequest } from "../model/model-contract-validation.js";
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
      const authFailure = response.status === 401 || response.status === 403;
      throw new ModelProviderError({
        message: `Groq endpoint returned HTTP ${response.status}`,
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
