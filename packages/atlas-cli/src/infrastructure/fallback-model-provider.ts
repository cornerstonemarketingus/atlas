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
  /**
   * Told every time a failed route hands the request to the next one, so the
   * switch is visible (the CLI prints it, naming whether the next route is
   * remote). Never given request or response content.
   */
  readonly onFallback?: (event: { readonly from: string; readonly to: string; readonly code: string; readonly toIndex: number }) => void;
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
  readonly #onFallback: FallbackModelProviderOptions["onFallback"];
  #waitedMs = 0;

  public constructor(routes: readonly FallbackModelRoute[], options: FallbackModelProviderOptions = {}) {
    if (routes.length === 0) throw new TypeError("FallbackModelProvider requires at least one route.");
    const capacityWaitMs = options.capacityWaitMs ?? 0;
    if (!Number.isSafeInteger(capacityWaitMs) || capacityWaitMs < 0) throw new RangeError("capacityWaitMs must be a non-negative integer.");
    this.#routes = [...routes];
    this.#capacityWaitMs = capacityWaitMs;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onFallback = options.onFallback;
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
      // Routes only the owner can fix (rejected key, no credit, model gone) neither count as
      // capacity nor hold the chain back from waiting on the routes that will recover.
      let unusable = 0;
      let capacityLimited = 0;
      let otherFailures = 0;
      let soonestMs = Number.POSITIVE_INFINITY;
      for (const [index, route] of this.#routes.entries()) {
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
          if (isOutOfCapacity(error)) { capacityLimited += 1; soonestMs = Math.min(soonestMs, error.retryAfterMs ?? UNSTATED_CAPACITY_WAIT_MS); }
          else if (isUnusable(error)) unusable += 1;
          else otherFailures += 1;
          const next = this.#routes[index + 1];
          if (next !== undefined) this.#onFallback?.({ from: `${route.provider.metadata.id}/${route.model}`, to: `${next.provider.metadata.id}/${next.model}`, code: error.code, toIndex: index + 1 });
        }
      }
      const allOutOfCapacity = capacityLimited > 0 && otherFailures === 0;
      const delayMs = Number.isFinite(soonestMs) ? Math.max(1, Math.ceil(soonestMs)) : UNSTATED_CAPACITY_WAIT_MS;
      if (!allOutOfCapacity || last === undefined || this.#waitedMs + delayMs > this.#capacityWaitMs) {
        throw chained(last!, failures, allOutOfCapacity && Number.isFinite(soonestMs) ? soonestMs : undefined, unusable);
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

/** A refusal that waiting cannot fix and only the owner can: the key, the billing or the permission. A model that is simply gone keeps its own, stricter handling. */
function isUnusable(error: ModelProviderError): boolean {
  return error.code === "authentication";
}

function isCapacityFailure(error: ModelProviderError): boolean {
  return /capacity|overload|temporar(?:ily|y) unavailable|tokens per minute/iu.test(error.message);
}

function chained(error: ModelProviderError, failures: readonly string[], resetMs?: number, unusable = 0): ModelProviderError {
  const reset = resetMs === undefined ? "" : ` Every ${unusable > 0 ? "usable " : ""}route is out of capacity; the soonest stated reset is in about ${Math.max(1, Math.round(resetMs / 60_000))} min.`;
  const unusableNote = unusable > 0 ? ` ${unusable} route${unusable === 1 ? " is" : "s are"} unusable until the account, key or model is fixed.` : "";
  return new ModelProviderError({
    message: `${error.message}${failures.length > 1 ? ` (routes tried: ${failures.join(", ")})` : ""}${reset}${unusableNote}`,
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
