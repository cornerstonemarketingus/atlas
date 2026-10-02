import type {
  ModelCapabilities,
  ModelProvider,
  ModelProviderErrorCode,
  ModelProviderMetadata,
  ModelRequest,
  ModelResponse,
} from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { validateModelRequest } from "../model/model-contract-validation.js";
import {
  ANTHROPIC_VERSION,
  buildAnthropicMessagesPayload,
  parseAnthropicMessagesResponse,
} from "./anthropic-message-format.js";
import { isBillingExhausted } from "./billing-exhaustion.js";

const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
/** Higher than the Groq default: non-streaming Claude turns can legitimately run for minutes. */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ERROR_BODY_EXCERPT_LIMIT = 512;

/**
 * Capabilities for the current Claude models. Context windows and output caps
 * come from the maintained model reference rather than from recall, because
 * model IDs and limits change; callers may pass their own list instead.
 */
export const DEFAULT_ANTHROPIC_MODELS: readonly ModelCapabilities[] = [
  { model: "claude-opus-5", contextWindowTokens: 1_000_000, maxOutputTokens: 128_000, supportsTools: true, supportsJson: true, supportsStreaming: false },
  { model: "claude-sonnet-5", contextWindowTokens: 1_000_000, maxOutputTokens: 128_000, supportsTools: true, supportsJson: true, supportsStreaming: false },
  { model: "claude-haiku-4-5", contextWindowTokens: 200_000, maxOutputTokens: 64_000, supportsTools: true, supportsJson: true, supportsStreaming: false },
];

export interface AnthropicModelProviderOptions {
  readonly apiKey: string;
  readonly models?: readonly ModelCapabilities[];
  readonly endpoint?: string | URL;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly anthropicVersion?: string;
  /** Applied when a request omits `maxOutputTokens`, which Anthropic requires. */
  readonly defaultMaxOutputTokens?: number;
  readonly fetchImplementation?: typeof fetch;
}

/**
 * Calls Anthropic's Messages API. Like GroqModelProvider — and unlike
 * LocalOpenAiCompatibleModelProvider — this is a real remote provider and is
 * deliberately not loopback-restricted.
 *
 * The wire format is not OpenAI-compatible, so translation lives in
 * anthropic-message-format.ts and this class owns only transport, bounding and
 * error classification. Auth is the `x-api-key` header (never a Bearer token)
 * plus the required `anthropic-version` header.
 */
export class AnthropicModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  readonly #apiKey: string;
  readonly #endpoint: URL;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #anthropicVersion: string;
  readonly #defaultMaxOutputTokens: number | undefined;
  readonly #fetch: typeof fetch;

  public constructor(options: AnthropicModelProviderOptions) {
    if (options.apiKey.trim().length === 0) throw new TypeError("AnthropicModelProvider requires a non-empty apiKey.");
    this.#apiKey = options.apiKey;
    this.#endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#anthropicVersion = options.anthropicVersion ?? ANTHROPIC_VERSION;
    this.#defaultMaxOutputTokens = options.defaultMaxOutputTokens;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.metadata = {
      id: "anthropic",
      displayName: "Anthropic",
      models: [...(options.models ?? DEFAULT_ANTHROPIC_MODELS)],
    };
  }

  public async complete(request: ModelRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ModelResponse> {
    const validated = validateModelRequest(request);
    const payload = buildAnthropicMessagesPayload(
      validated,
      this.#defaultMaxOutputTokens === undefined ? {} : { defaultMaxOutputTokens: this.#defaultMaxOutputTokens },
    );
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": this.#anthropicVersion,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (cause) {
      const cancelled = options.signal?.aborted === true;
      throw new ModelProviderError({
        message: cancelled ? "Anthropic request cancelled" : "Anthropic request failed",
        code: cancelled ? "cancelled" : "provider-failure",
        providerId: this.metadata.id,
        retryable: !cancelled,
        cause,
      });
    }

    const text = await response.text();
    if (Buffer.byteLength(text) > this.#maxResponseBytes) {
      throw new ModelProviderError({
        message: "Anthropic response exceeded the configured size limit",
        code: "provider-failure",
        providerId: this.metadata.id,
        retryable: false,
      });
    }
    if (!response.ok) {
      // Anthropic answers an exhausted account's credit balance with a plain
      // 400 ("Your credit balance is too low..."), the same status a bad
      // model ID or malformed message sequence uses, and that error cannot
      // clear on retry the way the other 400s theoretically could after a
      // caller-side fix. It is checked before the generic status mapping so
      // it is never mistaken for one of those.
      const classified = isBillingExhausted(text)
        ? { code: "billing-exhausted" as const, retryable: false }
        : classifyStatus(response.status);
      // The status code alone is ambiguous here - a 400 can mean a bad model
      // ID, an unsupported parameter or a malformed message sequence, and only
      // the body says which. It is echoed (truncated, and with any accidental
      // occurrence of the key redacted) so failures are debuggable from logs.
      throw new ModelProviderError({
        message: `Anthropic endpoint returned HTTP ${response.status}: ${this.#excerpt(text)}`,
        code: classified.code,
        providerId: this.metadata.id,
        retryable: classified.retryable,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new ModelProviderError({
        message: "Anthropic endpoint returned invalid JSON",
        code: "provider-failure",
        providerId: this.metadata.id,
        retryable: false,
        cause,
      });
    }
    return parseAnthropicMessagesResponse(parsed, this.metadata.id);
  }

  /** Single-line, length-bounded, key-free excerpt of a response body. */
  #excerpt(body: string): string {
    const collapsed = body.split(this.#apiKey).join("[redacted]").replace(/\s+/gu, " ").trim();
    if (collapsed.length === 0) return "<empty body>";
    return collapsed.length > ERROR_BODY_EXCERPT_LIMIT
      ? `${collapsed.slice(0, ERROR_BODY_EXCERPT_LIMIT)}...`
      : collapsed;
  }
}

function classifyStatus(status: number): { readonly code: ModelProviderErrorCode; readonly retryable: boolean } {
  if (status === 401 || status === 403) return { code: "authentication", retryable: false };
  if (status === 404) return { code: "model-unavailable", retryable: false };
  if (status === 429) return { code: "rate-limit", retryable: true };
  // 413 (request_too_large) is a caller-side problem, like 400.
  if (status === 400 || status === 413 || status === 422) return { code: "invalid-request", retryable: false };
  // 529 is Anthropic's "overloaded" status and falls into the retryable 5xx range.
  return { code: "provider-failure", retryable: status >= 500 };
}
