import type { ModelCapabilities, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse, ModelCompletionOptions } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { validateModelRequest } from "../model/model-contract-validation.js";
import { buildOpenAiChatPayload, parseOpenAiChatResponse } from "./openai-compatible-chat-format.js";
import { retryAfterHeaderMs } from "./rate-limit-timing.js";

export type CloudProviderId = "openai" | "workers-ai" | "cerebras" | "gemini" | "openrouter" | "mistral";

/** Chat-completions endpoint and display name per vendor; Workers AI's is per account. */
const DESTINATIONS: Readonly<Record<Exclude<CloudProviderId, "workers-ai">, { readonly url: string; readonly name: string }>> = {
  openai: { url: "https://api.openai.com/v1/chat/completions", name: "OpenAI" },
  cerebras: { url: "https://api.cerebras.ai/v1/chat/completions", name: "Cerebras" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", name: "Google Gemini" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", name: "OpenRouter" },
  mistral: { url: "https://api.mistral.ai/v1/chat/completions", name: "Mistral" },
};

/** Fixed vendor destinations: custom endpoints must use the separate compatible-server path. */
export class CloudModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  public constructor(private readonly options: { providerId: CloudProviderId; apiKey: string; models: readonly ModelCapabilities[]; accountId?: string; fetchImplementation?: typeof fetch; timeoutMs?: number }) {
    if (!options.apiKey.trim()) throw new TypeError("A cloud model credential is required.");
    if (options.providerId === "workers-ai" && !/^[a-f0-9]{32}$/iu.test(options.accountId ?? "")) throw new TypeError("Workers AI requires CLOUDFLARE_ACCOUNT_ID (32 hex characters).");
    const destination = options.providerId === "workers-ai" ? undefined : DESTINATIONS[options.providerId];
    if (options.providerId !== "workers-ai" && destination === undefined) throw new TypeError("Unknown cloud model provider.");
    this.endpoint = new URL(destination?.url ?? "https://api.cloudflare.com/client/v4/accounts/" + options.accountId + "/ai/v1/chat/completions");
    this.metadata = { id: options.providerId, displayName: destination?.name ?? "Workers AI", models: [...options.models] };
    this.fetcher = options.fetchImplementation ?? fetch;
  }
  public async complete(request: ModelRequest, options: ModelCompletionOptions = {}): Promise<ModelResponse> {
    // OpenAI function names exclude dots; Atlas tool IDs are namespaced.
    // A request-local bijection preserves the registry's exact original IDs.
    const names = new Map<string, string>();
    for (const [index, tool] of (request.tools ?? []).entries()) names.set(tool.name, "atlas_" + index + "_" + tool.name.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 48));
    const wireRequest = { ...request,
      ...(request.tools === undefined ? {} : { tools: request.tools.map((tool) => ({ ...tool, name: names.get(tool.name)! })) }),
      messages: request.messages.map((message) => message.role !== "assistant" ? message : ({ ...message, content: message.content.map((part) => part.type !== "tool-call" ? part : ({ ...part, name: names.get(part.name) ?? part.name })) })),
    };
    const payload = buildOpenAiChatPayload(validateModelRequest(wireRequest));
    if (this.options.providerId === "openai" && request.maxOutputTokens !== undefined) {
      delete payload["max_tokens"];
      payload["max_completion_tokens"] = request.maxOutputTokens;
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, { method: "POST", redirect: "error", signal,
        headers: { authorization: "Bearer " + this.options.apiKey, "content-type": "application/json" }, body: JSON.stringify(payload) });
    } catch (cause) {
      throw new ModelProviderError({ message: options.signal?.aborted ? "Cloud model request cancelled" : "Cloud model transport failed", code: options.signal?.aborted ? "cancelled" : "provider-failure", providerId: this.metadata.id, retryable: !options.signal?.aborted, cause });
    }
    const bytes: Uint8Array[] = []; let size = 0;
    const reader = response.body?.getReader();
    try {
      if (reader) for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 4 * 1024 * 1024) throw new Error("Cloud model response exceeds 4 MiB.");
        bytes.push(next.value);
      }
    } catch (cause) {
      await reader?.cancel().catch(() => undefined);
      throw new ModelProviderError({ message: "Cloud model response could not be read within its bound", code: options.signal?.aborted ? "cancelled" : "provider-failure", providerId: this.metadata.id, retryable: false, cause });
    } finally { reader?.releaseLock(); }
    if (!response.ok) {
      const auth = response.status === 401 || response.status === 403;
      const capacity = response.status === 413;
      const wait = retryAfterHeaderMs(response.headers);
      // Never copy provider response bodies: they can echo prompts, keys or account metadata.
      throw new ModelProviderError({ message: this.metadata.id + " returned HTTP " + response.status + (capacity ? ": capacity exceeded for this request" : ""),
        code: auth ? "authentication" : response.status === 429 ? "rate-limit" : response.status === 404 || capacity ? "model-unavailable" : response.status === 400 ? "invalid-request" : "provider-failure",
        providerId: this.metadata.id, retryable: response.status === 429 || response.status >= 500, ...(wait === undefined ? {} : { retryAfterMs: wait }) });
    }
    try {
      const result = parseOpenAiChatResponse(JSON.parse(Buffer.concat(bytes).toString("utf8")), this.metadata.id);
      if (!result.message.content.some((part) => part.type === "tool-call" || part.text.trim().length > 0)) throw new Error("Empty model response");
      const originals = new Map([...names].map(([original, wire]) => [wire, original]));
      return { ...result, message: { ...result.message, content: result.message.content.map((part) => part.type !== "tool-call" ? part : ({ ...part, name: originals.get(part.name) ?? part.name })) } };
    } catch (cause) {
      throw new ModelProviderError({ message: "Cloud model returned an empty or invalid completion", code: "model-unavailable", providerId: this.metadata.id, retryable: false, cause });
    }
  }
}
