import type {
  ModelCompletionOptions,
  ModelProvider,
  ModelProviderMetadata,
  ModelRequest,
  ModelResponse,
} from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";

export interface RetryingModelProviderOptions {
  /** Total attempts including the first, not additional retries. Defaults to 3. */
  readonly maximumAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

// Groq's rate-limit body names a concrete wait, e.g. "Please try again in
// 21.645s." — honoring it is far more precise than a fixed backoff schedule.
const SUGGESTED_DELAY_PATTERN = /try again in ([\d.]+)\s*s/iu;

/**
 * Retries a wrapped provider's transient failures (rate limits, 5xx) with
 * backoff. Non-retryable errors (auth, invalid request, cancellation) pass
 * through immediately. Wrap the raw provider with this *before* handing it
 * to BudgetedModelProvider so a retried call still only records usage once,
 * on the attempt that actually succeeds.
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
      attempt += 1;
      try {
        return await this.#provider.complete(request, options);
      } catch (error: unknown) {
        if (!(error instanceof ModelProviderError) || !error.retryable || attempt >= this.#maximumAttempts) {
          throw error;
        }
        const delayMs = Math.min(
          this.#maximumDelayMs,
          suggestedDelayMs(error) ?? this.#baseDelayMs * 2 ** (attempt - 1),
        );
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
}

function suggestedDelayMs(error: ModelProviderError): number | undefined {
  const match = SUGGESTED_DELAY_PATTERN.exec(error.message);
  if (match?.[1] === undefined) return undefined;
  const seconds = Number.parseFloat(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
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
