import type { ModelCapabilities, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { validateModelRequest } from "../model/model-contract-validation.js";
import { BoundedJsonHttpTransport, JsonHttpTransportError } from "./bounded-json-http-transport.js";
import { buildOpenAiChatPayload, parseOpenAiChatResponse } from "./openai-compatible-chat-format.js";
import { isBillingExhausted } from "./billing-exhaustion.js";

export interface LocalOpenAiCompatibleProviderOptions {
  readonly endpoint: URL | string;
  readonly models: readonly ModelCapabilities[];
  readonly providerId?: string;
  readonly displayName?: string;
  readonly transport?: BoundedJsonHttpTransport;
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
    const payload = buildOpenAiChatPayload(validated);
    try {
      return parseOpenAiChatResponse(await this.transport.post(this.endpoint, payload, options), this.metadata.id);
    } catch (cause) {
      if (cause instanceof ModelProviderError) throw cause;
      const cancelled = cause instanceof JsonHttpTransportError && cause.kind === "cancelled";
      const status = cause instanceof JsonHttpTransportError ? cause.statusCode : undefined;
      // A local target is usually Ollama/llama.cpp with no billing at all,
      // but it can also be a proxy fronting a billed API (LiteLLM, a
      // self-hosted router, etc.) that forwards the upstream error verbatim.
      const billingExhausted = status === 429 && cause instanceof JsonHttpTransportError && isBillingExhausted(cause.body ?? "");
      throw new ModelProviderError({
        message: cancelled ? "Local model request cancelled" : "Local model request failed",
        code: cancelled ? "cancelled" : billingExhausted ? "billing-exhausted" : status === 400 ? "invalid-request" : status === 404 ? "model-unavailable" : status === 429 ? "rate-limit" : "provider-failure",
        providerId: this.metadata.id, retryable: !cancelled && !billingExhausted && (status === undefined || status === 429 || status >= 500), cause,
      });
    }
  }
}
