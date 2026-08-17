import type {
  ModelCapabilities,
  ModelProvider,
} from "./model-provider.js";

export interface ModelRouteRequirements {
  readonly tools?: boolean;
  readonly json?: boolean;
  readonly streaming?: boolean;
  readonly minimumContextWindowTokens?: number;
  readonly minimumOutputTokens?: number;
  readonly preferredProviderId?: string;
  readonly preferredModel?: string;
}

export interface RegisteredModel {
  readonly provider: ModelProvider;
  readonly capabilities: ModelCapabilities;
}

export type ModelRegistryErrorCode =
  | "duplicate-provider"
  | "duplicate-model"
  | "ambiguous-model-preference"
  | "invalid-requirements"
  | "unsupported-requirements";

export class ModelRegistryError extends Error {
  public readonly code: ModelRegistryErrorCode;

  public constructor(code: ModelRegistryErrorCode, message: string) {
    super(message);
    this.name = "ModelRegistryError";
    this.code = code;
  }
}

/** Immutable registry and deterministic capability router for model providers. */
export class ModelRegistry {
  readonly #models: readonly RegisteredModel[];

  public constructor(providers: readonly ModelProvider[]) {
    const providerIds = new Set<string>();
    const models: RegisteredModel[] = [];

    for (const provider of providers) {
      const providerId = provider.metadata.id;
      if (providerIds.has(providerId)) {
        throw new ModelRegistryError(
          "duplicate-provider",
          `Provider ID is registered more than once: ${providerId}`,
        );
      }
      providerIds.add(providerId);

      const modelNames = new Set<string>();
      for (const capabilities of provider.metadata.models) {
        if (modelNames.has(capabilities.model)) {
          throw new ModelRegistryError(
            "duplicate-model",
            `Model is registered more than once for provider ${providerId}: ${capabilities.model}`,
          );
        }
        modelNames.add(capabilities.model);
        models.push({ provider, capabilities });
      }
    }

    this.#models = [...models].sort(compareModelIdentity);
  }

  public list(): readonly RegisteredModel[] {
    return this.#models;
  }

  public route(requirements: ModelRouteRequirements = {}): RegisteredModel {
    validateRequirements(requirements);

    if (requirements.preferredModel !== undefined && requirements.preferredProviderId === undefined) {
      const matchingProviders = new Set(
        this.#models
          .filter(({ capabilities }) => capabilities.model === requirements.preferredModel)
          .map(({ provider }) => provider.metadata.id),
      );
      if (matchingProviders.size > 1) {
        throw new ModelRegistryError(
          "ambiguous-model-preference",
          `Preferred model ${requirements.preferredModel} exists in multiple providers; specify preferredProviderId`,
        );
      }
    }

    const candidates = this.#models.filter(({ capabilities }) =>
      supportsRequirements(capabilities, requirements),
    );
    if (candidates.length === 0) {
      throw new ModelRegistryError(
        "unsupported-requirements",
        "No registered model satisfies the requested capabilities and limits",
      );
    }

    return [...candidates].sort((left, right) =>
      preferenceRank(left, requirements) - preferenceRank(right, requirements)
      || compareModelIdentity(left, right),
    )[0]!;
  }
}

function supportsRequirements(
  capabilities: ModelCapabilities,
  requirements: ModelRouteRequirements,
): boolean {
  return (requirements.tools !== true || capabilities.supportsTools)
    && (requirements.json !== true || capabilities.supportsJson)
    && (requirements.streaming !== true || capabilities.supportsStreaming)
    && capabilities.contextWindowTokens >= (requirements.minimumContextWindowTokens ?? 0)
    && capabilities.maxOutputTokens >= (requirements.minimumOutputTokens ?? 0);
}

function preferenceRank(model: RegisteredModel, requirements: ModelRouteRequirements): number {
  const providerMatches = model.provider.metadata.id === requirements.preferredProviderId;
  const modelMatches = model.capabilities.model === requirements.preferredModel;
  if (requirements.preferredProviderId !== undefined && requirements.preferredModel !== undefined) {
    return providerMatches && modelMatches ? 0 : providerMatches ? 1 : modelMatches ? 2 : 3;
  }
  if (requirements.preferredProviderId !== undefined) return providerMatches ? 0 : 1;
  if (requirements.preferredModel !== undefined) return modelMatches ? 0 : 1;
  return 0;
}

function compareModelIdentity(left: RegisteredModel, right: RegisteredModel): number {
  return left.provider.metadata.id.localeCompare(right.provider.metadata.id)
    || left.capabilities.model.localeCompare(right.capabilities.model);
}

function validateRequirements(requirements: ModelRouteRequirements): void {
  for (const [name, value] of [
    ["minimumContextWindowTokens", requirements.minimumContextWindowTokens],
    ["minimumOutputTokens", requirements.minimumOutputTokens],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ModelRegistryError(
        "invalid-requirements",
        `${name} must be a non-negative safe integer`,
      );
    }
  }
}
