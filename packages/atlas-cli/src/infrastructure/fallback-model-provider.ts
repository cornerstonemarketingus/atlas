import type { ModelCompletionOptions, ModelProvider, ModelProviderMetadata, ModelRequest, ModelResponse } from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";

export interface FallbackModelRoute {
  readonly provider: ModelProvider;
  readonly model: string;
}

/**
 * Tries an explicitly configured route only after the previous route has
 * exhausted its own transient retries. It never restarts the agent, so tool
 * calls and repository edits cannot be duplicated by a fallback.
 */
export class FallbackModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  readonly #routes: readonly FallbackModelRoute[];

  public constructor(routes: readonly FallbackModelRoute[]) {
    if (routes.length === 0) throw new TypeError("FallbackModelProvider requires at least one route.");
    this.#routes = [...routes];
    this.metadata = {
      id: "fallback",
      displayName: "Explicit model fallback chain",
      models: routes.flatMap((route) => route.provider.metadata.models.filter((item) => item.model === route.model)),
    };
  }

  public async complete(request: ModelRequest, options: ModelCompletionOptions = {}): Promise<ModelResponse> {
    const failures: string[] = [];
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
        const mayFallback = error.retryable || error.code === "model-unavailable" || isCapacityFailure(error);
        if (!mayFallback || index === this.#routes.length - 1) {
          throw new ModelProviderError({
            message: `${error.message}${failures.length > 1 ? ` (routes tried: ${failures.join(", ")})` : ""}`,
            code: error.code,
            providerId: error.providerId,
            retryable: error.retryable,
            cause: error,
          });
        }
      }
    }
    throw new Error("Model fallback chain ended unexpectedly.");
  }
}

function isCapacityFailure(error: ModelProviderError): boolean {
  return /capacity|overload|temporar(?:ily|y) unavailable|tokens per minute/iu.test(error.message);
}
