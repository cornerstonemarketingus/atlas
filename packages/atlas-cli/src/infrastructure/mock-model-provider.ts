import {
  ModelProviderError,
  type ModelCompletionOptions,
  type ModelProvider,
  type ModelProviderMetadata,
  type ModelRequest,
  type ModelResponse,
} from "../model/model-provider.js";

export interface MockModelProviderOptions {
  readonly metadata: ModelProviderMetadata;
  readonly responses: readonly ModelResponse[];
}

/** Deterministic, offline provider intended for agent tests and local development. */
export class MockModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  public readonly requests: ModelRequest[] = [];
  readonly #responses: ModelResponse[];

  public constructor(options: MockModelProviderOptions) {
    this.metadata = structuredClone(options.metadata);
    this.#responses = structuredClone([...options.responses]);
  }

  public async complete(
    request: ModelRequest,
    options: ModelCompletionOptions = {},
  ): Promise<ModelResponse> {
    if (options.signal?.aborted === true) {
      throw new ModelProviderError({
        message: "Model request was cancelled.",
        code: "cancelled",
        providerId: this.metadata.id,
        retryable: false,
        cause: options.signal.reason,
      });
    }

    if (!this.metadata.models.some((candidate) => candidate.model === request.model)) {
      throw new ModelProviderError({
        message: `Mock provider does not support model '${request.model}'.`,
        code: "model-unavailable",
        providerId: this.metadata.id,
        retryable: false,
      });
    }

    const response = this.#responses.shift();
    if (response === undefined) {
      throw new ModelProviderError({
        message: "Mock provider has no configured response remaining.",
        code: "provider-failure",
        providerId: this.metadata.id,
        retryable: false,
      });
    }

    this.requests.push(structuredClone(request));
    return structuredClone(response);
  }
}
