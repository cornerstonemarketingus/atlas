import type {
  ModelCompletionOptions,
  ModelProvider,
  ModelProviderMetadata,
  ModelRequest,
  ModelResponse,
} from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import { suggestedWaitFromMessage } from "./rate-limit-timing.js";

export interface RetryingModelProviderOptions {
  /** Total attempts including the first, not additional retries. Defaults to 3. */
  readonly maximumAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Retries a wrapped provider's transient failures (rate limits, 5xx) with
 * backoff. Non-retryable errors (auth, invalid request, cancellation) pass
 * through immediately. Wrap the raw provider with this *before* handing it
 * to BudgetedModelProvider so a retried call still only records usage once,
 * on the attempt that actually succeeds.
 *
 * When the provider names a wait (retry-after, or Groq's "Please try again in
 * 2m59.56s.") that wait is honoured exactly. If it is longer than
 * maximumDelayMs — a daily quota, typically — retrying sooner is certain to
 * fail, so the error is raised at once and a fallback route can take over.
 */
export class RetryingModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  readonly #provider: ModelProvider;
  readonly #maximumAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maximumDelayMs: number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  public constructor(provider: ModelProvider, options: RetryingModelProviderOptions = {}) {
    this.#provider = provider;
    this.metadata = provider.metadata;
    this.#maximumAttempts = options.maximumAttempts ?? 3;
    this.#baseDelayMs = options.baseDelayMs ?? 2_000;
    this.#maximumDelayMs = options.maximumDelayMs ?? 30_000;
    this.#sleep = options.sleep ?? defaultSleep;
    if (!Number.isInteger(this.#maximumAttempts) || this.#maximumAttempts < 1 || this.#maximumAttempts > 10) {
      throw new RangeError("maximumAttempts must be an integer between 1 and 10.");
    }
  }

  public async complete(request: ModelRequest, options: ModelCompletionOptions = {}): Promise<ModelResponse> {
    let attempt = 0;
    for (;;) {
      this.#throwIfCancelled(options.signal);
      attempt += 1;
      try {
        const response = await this.#provider.complete(request, options);
        this.#throwIfCancelled(options.signal);
        return response;
      } catch (error: unknown) {
        this.#throwIfCancelled(options.signal);
        if (!(error instanceof ModelProviderError) || !error.retryable || attempt >= this.#maximumAttempts) {
          throw error;
        }
        const suggested = error.retryAfterMs ?? suggestedWaitFromMessage(error.message);
        if (suggested !== undefined && suggested > this.#maximumDelayMs) throw error;
        const delayMs = suggested ?? Math.min(this.#maximumDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
        try {
          await this.#sleep(delayMs, options.signal);
        } catch {
          throw new ModelProviderError({
            message: "Retry cancelled",
            code: "cancelled",
            providerId: this.metadata.id,
            retryable: false,
          });
        }
      }
    }
  }

  #throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ModelProviderError({
        message: "Model request cancelled",
        code: "cancelled",
        providerId: this.metadata.id,
        retryable: false,
      });
    }
  }
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
