import type { ModelCapabilities, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse, ModelCompletionOptions } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { validateModelRequest } from "../model/model-contract-validation.js";
import { buildOpenAiChatPayload, parseOpenAiChatResponse } from "./openai-compatible-chat-format.js";
import { retryAfterHeaderMs } from "./rate-limit-timing.js";

/** Fixed vendor destinations: custom endpoints must use the separate compatible-server path. */
export class CloudModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  public constructor(private readonly options: { providerId: "openai" | "workers-ai"; apiKey: string; models: readonly ModelCapabilities[]; accountId?: string; fetchImplementation?: typeof fetch; timeoutMs?: number }) {
    if (!options.apiKey.trim()) throw new TypeError("A cloud model credential is required.");
    if (options.providerId === "workers-ai" && !/^[a-f0-9]{32}$/iu.test(options.accountId ?? "")) throw new TypeError("Workers AI requires CLOUDFLARE_ACCOUNT_ID (32 hex characters).");
    this.endpoint = new URL(options.providerId === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://api.cloudflare.com/client/v4/accounts/" + options.accountId + "/ai/v1/chat/completions");
    this.metadata = { id: options.providerId, displayName: options.providerId === "openai" ? "OpenAI" : "Workers AI", models: [...options.models] };
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
    const { response, bytes } = await readCloudResponse(this.fetcher, this.endpoint, payload, this.options.apiKey, this.metadata.id, this.options.timeoutMs ?? 60_000, options.signal);
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

/** One deadline covers headers and the entire bounded body, independent of fetch cooperation. */
async function readCloudResponse(fetcher: typeof fetch, endpoint: URL, payload: Record<string, unknown>, apiKey: string, providerId: string, timeoutMs: number, callerSignal?: AbortSignal): Promise<{ response: Response; bytes: Uint8Array[] }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError("Invalid cloud response timeout");
  const interruption = () => new ModelProviderError({ message: callerSignal?.aborted ? "Cloud model request cancelled" : "Cloud model response deadline exceeded", code: callerSignal?.aborted ? "cancelled" : "provider-failure", providerId, retryable: !callerSignal?.aborted });
  if (callerSignal?.aborted) throw interruption();
  const controller = new AbortController();
  let interrupt!: () => void;
  const stopped = new Promise<never>((_, reject) => { interrupt = () => { controller.abort(); reject(interruption()); }; });
  const timer = setTimeout(interrupt, timeoutMs);
  callerSignal?.addEventListener("abort", interrupt, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyComplete = false;
  try {
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw interruption();
      return fetcher(endpoint, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" }, body: JSON.stringify(payload) });
    });
    // A late transport result must not retain a body after the caller has left.
    void pending.then(response => {
      if (controller.signal.aborted) { try { void response.body?.cancel().catch(() => undefined); } catch { /* discard late response */ } }
    }, () => undefined);
    const response = await Promise.race([pending, stopped]);
    if (!response.ok) {
      // Status and retry headers are sufficient; never let an error body hide
      // terminal authentication failure behind a retryable body timeout.
      try { void response.body?.cancel().catch(() => undefined); } catch { /* discard provider body */ }
      bodyComplete = true;
      return { response, bytes: [] };
    }
    const bytes: Uint8Array[] = []; let size = 0;
    reader = response.body?.getReader();
    if (reader) for (;;) {
      const next = await Promise.race([reader.read(), stopped]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4 * 1024 * 1024) throw new ModelProviderError({ message: "Cloud model response could not be read within its bound", code: "provider-failure", providerId, retryable: false });
      bytes.push(next.value);
    }
    if (controller.signal.aborted) throw interruption();
    bodyComplete = true;
    return { response, bytes };
  } catch (cause) {
    if (cause instanceof ModelProviderError) throw cause;
    throw new ModelProviderError({ message: "Cloud model transport or response failed", code: callerSignal?.aborted ? "cancelled" : "provider-failure", providerId, retryable: !callerSignal?.aborted, cause });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", interrupt);
    // Never await cancellation: an underlying source may ignore it indefinitely.
    if (!bodyComplete) { controller.abort(); try { void reader?.cancel().catch(() => undefined); } catch { /* best effort */ } }
    try { reader?.releaseLock(); } catch { /* interrupted read owns no future work */ }
  }
}
