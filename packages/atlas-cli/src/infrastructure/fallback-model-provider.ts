import type { ModelCompletionOptions, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";

export interface FallbackModelRoute {
  readonly provider: ModelProvider;
  readonly model: string;
}

export interface FallbackModelProviderOptions {
  /**
   * How long this provider (one agent run) may wait, in total, for capacity
   * to return when every route is rate-limited or over capacity. Waiting
   * keeps the agent's work so far; failing would throw it away. 0 disables
   * waiting.
   */
  readonly capacityWaitMs?: number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/** When no route said how long to wait, check again after this long. */
const UNSTATED_CAPACITY_WAIT_MS = 30_000;

/**
 * Tries an explicitly configured route only after the previous route has
 * exhausted its own transient retries. It never restarts the agent, so tool
 * calls and repository edits cannot be duplicated by a fallback.
 *
 * Any refusal another provider might not share moves to the next route: a
 * rate limit, a server error, a model that is gone, a request over one
 * provider's allowance, or a rejected key. A malformed request or a
 * cancellation stops, because every route would refuse it alike.
 *
 * When every route is out of capacity, the chain waits for the soonest
 * stated reset and tries again, within `capacityWaitMs`.
 */
export class FallbackModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  readonly #routes: readonly FallbackModelRoute[];
  readonly #capacityWaitMs: number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  #waitedMs = 0;

  public constructor(routes: readonly FallbackModelRoute[], options: FallbackModelProviderOptions = {}) {
    if (routes.length === 0) throw new TypeError("FallbackModelProvider requires at least one route.");
    const capacityWaitMs = options.capacityWaitMs ?? 0;
    if (!Number.isSafeInteger(capacityWaitMs) || capacityWaitMs < 0) throw new RangeError("capacityWaitMs must be a non-negative integer.");
    this.#routes = [...routes];
    this.#capacityWaitMs = capacityWaitMs;
    this.#sleep = options.sleep ?? defaultSleep;
    this.metadata = {
      id: "fallback",
      displayName: "Explicit model fallback chain",
      models: routes.flatMap((route) => route.provider.metadata.models.filter((item) => item.model === route.model)),
    };
  }

  public async complete(request: ModelRequest, options: ModelCompletionOptions = {}): Promise<ModelResponse> {
    for (;;) {
      const failures: string[] = [];
      let last: ModelProviderError | undefined;
      let allOutOfCapacity = true;
      let soonestMs = Number.POSITIVE_INFINITY;
      for (const route of this.#routes) {
        const capabilities = route.provider.metadata.models.find((item) => item.model === route.model);
        if (!capabilities) throw new TypeError(`Provider '${route.provider.metadata.id}' does not declare model '${route.model}'.`);
        try {
          return await route.provider.complete({
            ...request,
            model: route.model,
            ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: Math.min(request.maxOutputTokens, capabilities.maxOutputTokens) }),
          }, options);
        } catch (error: unknown) {
          if (!(error instanceof ModelProviderError)) throw error;
          failures.push(`${route.provider.metadata.id}/${route.model}: ${error.code}`);
          last = error;
          if (error.code === "cancelled" || error.code === "invalid-request" || error.code === "tool-call-rejected") throw chained(error, failures);
          if (isOutOfCapacity(error)) soonestMs = Math.min(soonestMs, error.retryAfterMs ?? UNSTATED_CAPACITY_WAIT_MS);
          else allOutOfCapacity = false;
        }
      }
      const delayMs = Number.isFinite(soonestMs) ? Math.max(1, Math.ceil(soonestMs)) : UNSTATED_CAPACITY_WAIT_MS;
      if (!allOutOfCapacity || last === undefined || this.#waitedMs + delayMs > this.#capacityWaitMs) {
        throw chained(last!, failures, allOutOfCapacity && Number.isFinite(soonestMs) ? soonestMs : undefined);
      }
      try {
        await this.#sleep(delayMs, options.signal);
      } catch (cause) {
        throw new ModelProviderError({ message: "Waiting for model capacity was cancelled", code: "cancelled", providerId: "fallback", retryable: false, cause });
      }
      this.#waitedMs += delayMs;
    }
  }
}

/** A refusal that goes away with time: a rate limit, a server error, or an overloaded or over-allowance route. */
function isOutOfCapacity(error: ModelProviderError): boolean {
  if (error.code === "rate-limit") return true;
  if (error.code === "provider-failure") return error.retryable || isCapacityFailure(error);
  return error.code === "model-unavailable" && isCapacityFailure(error);
}

function isCapacityFailure(error: ModelProviderError): boolean {
  return /capacity|overload|temporar(?:ily|y) unavailable|tokens per minute/iu.test(error.message);
}

function chained(error: ModelProviderError, failures: readonly string[], resetMs?: number): ModelProviderError {
  const reset = resetMs === undefined ? "" : ` Every route is out of capacity; the soonest stated reset is in about ${Math.max(1, Math.round(resetMs / 60_000))} min.`;
  return new ModelProviderError({
    message: `${error.message}${failures.length > 1 ? ` (routes tried: ${failures.join(", ")})` : ""}${reset}`,
    code: error.code,
    providerId: error.providerId,
    retryable: error.retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    cause: error,
  });
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
