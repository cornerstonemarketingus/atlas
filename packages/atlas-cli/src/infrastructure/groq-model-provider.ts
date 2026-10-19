import type { ModelCapabilities, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { validateModelRequest, validateModelResponse } from "../model/model-contract-validation.js";
import { boundCoderContext } from "../model/bounded-coder-context.js";
import { buildOpenAiChatPayload, parseOpenAiChatResponse } from "./openai-compatible-chat-format.js";
import { parseDurationMs, retryAfterHeaderMs, suggestedWaitFromMessage } from "./rate-limit-timing.js";

const DEFAULT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// A token-per-minute window never needs more than a minute to refill; a
// longer reset is a daily quota, and sleeping on that would only hang the run.
const DEFAULT_MAX_PACING_WAIT_MS = 60_000;
// Rough upper bound for tokens in a JSON chat request. Over-estimating costs a
// short wait; under-estimating costs a 429 and a retry.
const BYTES_PER_TOKEN_ESTIMATE = 3;
// A refitted turn keeps at least this much room to answer: enough for a tool
// call with real arguments. Below it the request is not worth sending.
const MINIMUM_REFIT_OUTPUT_TOKENS = 1_024;
// Headroom under the stated allowance, for tokenizer differences.
const REFIT_MARGIN_TOKENS = 256;

export interface GroqModelProviderOptions {
  readonly apiKey: string;
  readonly models: readonly ModelCapabilities[];
  readonly endpoint?: string | URL;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
  /**
   * Wait for the token-per-minute window to refill before a request the last
   * response's `x-ratelimit-remaining-tokens` says cannot fit. Defaults to on.
   */
  readonly paceRequests?: boolean;
  readonly maximumPacingWaitMs?: number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

/**
 * What a "Request too large ... tokens per minute" refusal taught: the
 * account's per-request allowance, and how many bytes of request JSON one
 * of its tokens is (measured, not guessed, from the same refusal).
 */
interface RequestAllowance {
  readonly tokens: number;
  readonly bytesPerToken: number;
}

interface TokenWindow {
  readonly remainingTokens: number;
  readonly resetsAt: number;
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
  readonly #paceRequests: boolean;
  readonly #maximumPacingWaitMs: number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  #tokenWindow: TokenWindow | undefined;
  #allowance: RequestAllowance | undefined;

  public constructor(options: GroqModelProviderOptions) {
    if (options.apiKey.trim().length === 0) throw new TypeError("GroqModelProvider requires a non-empty apiKey.");
    this.#apiKey = options.apiKey;
    this.#endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#paceRequests = options.paceRequests ?? true;
    this.#maximumPacingWaitMs = options.maximumPacingWaitMs ?? DEFAULT_MAX_PACING_WAIT_MS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
    this.metadata = { id: "groq", displayName: "Groq", models: [...options.models] };
  }

  /**
   * A free or small Groq tier refuses any single request whose prompt plus
   * max_tokens exceeds its tokens-per-minute allowance, however long one
   * waits. The refusal states the allowance, so the request is refitted to it
   * once (a smaller reply budget first, then older re-readable tool output
   * replaced with a pointer to read it again) and every later turn is fitted
   * before it is sent. Nothing the objective, edits or errors said is removed.
   */
  public async complete(request: ModelRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ModelResponse> {
    const validated = validateModelRequest(request);
    const fitted = this.#fitToAllowance(validated) ?? validated;
    try {
      return await this.#send(fitted, options);
    } catch (error: unknown) {
      if (!(error instanceof AllowanceRefusal)) throw error;
      const refitted = this.#fitToAllowance(validated);
      if (refitted === undefined || sameSize(refitted, fitted)) throw error.providerError;
      try {
        return await this.#send(refitted, options);
      } catch (second: unknown) {
        throw second instanceof AllowanceRefusal ? second.providerError : second;
      }
    }
  }

  #fitToAllowance(request: ModelRequest): ModelRequest | undefined {
    const allowance = this.#allowance;
    if (allowance === undefined) return request;
    const budget = allowance.tokens - REFIT_MARGIN_TOKENS;
    const promptTokens = Math.ceil(requestBytes(request) / allowance.bytesPerToken);
    const wanted = request.maxOutputTokens ?? MINIMUM_REFIT_OUTPUT_TOKENS;
    if (promptTokens + wanted <= budget) return request;
    if (budget - promptTokens >= MINIMUM_REFIT_OUTPUT_TOKENS) return { ...request, maxOutputTokens: budget - promptTokens };
    const output = Math.min(wanted, MINIMUM_REFIT_OUTPUT_TOKENS);
    const bytes = Math.floor((budget - output) * allowance.bytesPerToken);
    if (bytes < 1) return undefined;
    const bounded = boundCoderContext(request, bytes);
    return bounded === undefined ? undefined : { ...bounded, maxOutputTokens: output };
  }

  async #send(validated: ModelRequest, options: { readonly signal?: AbortSignal }): Promise<ModelResponse> {
    const payload = buildOpenAiChatPayload(validated);
    const body = JSON.stringify(payload);
    await this.#waitForTokenWindow(body, options.signal);
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
        body,
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

    this.#recordTokenWindow(response.headers);
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

      const allowance = (response.status === 413 || response.status === 429) ? statedAllowance(text, validated) : undefined;

      const authFailure = response.status === 401 || response.status === 403;
      // Classify privately; provider bodies may echo prompts and credentials.
      // Preserve a fixed capacity description for the existing fallback policy.
      const detail = response.status === 413 ? ": capacity exceeded for this request" : "";
      const retryAfterMs = response.status === 429 || response.status >= 500
        ? retryAfterHeaderMs(response.headers) ?? suggestedWaitFromMessage(text)
        : undefined;
      const providerError = new ModelProviderError({
        message: `Groq endpoint returned HTTP ${response.status}${allowance === undefined ? detail : ": capacity exceeded for this request (tokens per minute)"}`,
        code: authFailure ? "authentication" : response.status === 429 && allowance === undefined ? "rate-limit" : "provider-failure",
        providerId: this.metadata.id,
        // Waiting never makes an over-allowance request fit; a fallback route may.
        retryable: !authFailure && allowance === undefined && (response.status === 429 || response.status >= 500),
        ...(retryAfterMs === undefined || allowance !== undefined ? {} : { retryAfterMs }),
      });
      if (allowance !== undefined) {
        this.#allowance = allowance;
        throw new AllowanceRefusal(providerError);
      }
      throw providerError;
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

  /**
   * An agent resends its whole conversation every turn, so on a small
   * tokens-per-minute allowance the second or third turn in a minute is
   * rejected. Groq says how much of the window is left on every response;
   * waiting for the refill up front is cheaper than a 429 and a retry, and
   * does not spend one of the retry attempts.
   */
  async #waitForTokenWindow(body: string, signal: AbortSignal | undefined): Promise<void> {
    const window = this.#tokenWindow;
    if (!this.#paceRequests || window === undefined) return;
    const waitMs = window.resetsAt - this.#now();
    if (waitMs <= 0) {
      this.#tokenWindow = undefined;
      return;
    }
    const estimatedTokens = Math.ceil(Buffer.byteLength(body) / BYTES_PER_TOKEN_ESTIMATE);
    if (estimatedTokens <= window.remainingTokens || waitMs > this.#maximumPacingWaitMs) return;
    try {
      await this.#sleep(waitMs, signal);
    } catch (cause) {
      throw new ModelProviderError({
        message: "Groq request cancelled",
        code: "cancelled",
        providerId: this.metadata.id,
        retryable: false,
        cause,
      });
    }
    this.#tokenWindow = undefined;
  }

  #recordTokenWindow(headers: Headers): void {
    const remaining = Number.parseInt(headers.get("x-ratelimit-remaining-tokens") ?? "", 10);
    const resetMs = parseDurationMs(headers.get("x-ratelimit-reset-tokens") ?? "");
    this.#tokenWindow = Number.isSafeInteger(remaining) && remaining >= 0 && resetMs !== undefined
      ? { remainingTokens: remaining, resetsAt: this.#now() + resetMs }
      : undefined;
  }
}

class AllowanceRefusal extends Error {
  public constructor(public readonly providerError: ModelProviderError) {
    super(providerError.message);
  }
}

function requestBytes(request: ModelRequest): number {
  return Buffer.byteLength(JSON.stringify(request), "utf8");
}

function sameSize(left: ModelRequest, right: ModelRequest): boolean {
  return requestBytes(left) === requestBytes(right) && left.maxOutputTokens === right.maxOutputTokens;
}

/**
 * Reads "Request too large ... on tokens per minute (TPM): Limit 8000,
 * Requested 9513" into numbers only; the rest of the body never leaves here.
 */
function statedAllowance(body: string, sent: ModelRequest): RequestAllowance | undefined {
  if (!/request too large/iu.test(body) || !/tokens per minute|\bTPM\b/iu.test(body)) return undefined;
  const match = /Limit\s+(\d+),\s*Requested\s+(\d+)/iu.exec(body);
  if (match === null) return undefined;
  const limit = Number(match[1]);
  const requested = Number(match[2]);
  const promptTokens = requested - (sent.maxOutputTokens ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(requested) || promptTokens < 1) return undefined;
  return { tokens: limit, bytesPerToken: requestBytes(sent) / promptTokens };
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
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
