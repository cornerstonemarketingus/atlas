export type ProviderKind = "hosted" | "local";

export type CredentialReference =
  | { readonly source: "environment"; readonly variable: string }
  | { readonly source: "keychain"; readonly id: string }
  | { readonly source: "managed"; readonly id: string };

export interface ModelProviderConfiguration {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly endpoint: string;
  readonly credential?: CredentialReference;
  readonly enabled: boolean;
}

export type ProviderConfigurationErrorCode =
  | "CREDENTIAL_REQUIRED"
  | "DUPLICATE_PROVIDER"
  | "INVALID_ENDPOINT"
  | "INVALID_IDENTIFIER"
  | "LOCAL_CREDENTIAL_NOT_ALLOWED";

export class ProviderConfigurationError extends Error {
  public constructor(
    public readonly code: ProviderConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export function validateProviderConfigurations(
  configurations: readonly ModelProviderConfiguration[],
): readonly ModelProviderConfiguration[] {
  const ids = new Set<string>();
  return configurations.map((configuration) => {
    assertIdentifier(configuration.id, "provider ID");
    if (ids.has(configuration.id)) {
      throw new ProviderConfigurationError(
        "DUPLICATE_PROVIDER",
        `Duplicate provider configuration: ${configuration.id}`,
      );
    }
    ids.add(configuration.id);
    validateEndpoint(configuration);
    if (configuration.kind === "hosted" && configuration.credential === undefined) {
      throw new ProviderConfigurationError(
        "CREDENTIAL_REQUIRED",
        `Hosted provider '${configuration.id}' requires a credential reference.`,
      );
    }
    if (configuration.kind === "local" && configuration.credential !== undefined) {
      throw new ProviderConfigurationError(
        "LOCAL_CREDENTIAL_NOT_ALLOWED",
        `Local provider '${configuration.id}' must not declare a credential reference.`,
      );
    }
    if (configuration.credential !== undefined) {
      const reference = configuration.credential.source === "environment"
        ? configuration.credential.variable
        : configuration.credential.id;
      assertIdentifier(reference, "credential reference");
    }
    return structuredClone(configuration);
  });
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value)) {
    throw new ProviderConfigurationError(
      "INVALID_IDENTIFIER",
      `${label} must contain 1-128 safe identifier characters.`,
    );
  }
}

function validateEndpoint(configuration: ModelProviderConfiguration): void {
  let endpoint: URL;
  try {
    endpoint = new URL(configuration.endpoint);
  } catch {
    throw new ProviderConfigurationError("INVALID_ENDPOINT", "Provider endpoint must be a valid URL.");
  }
  const allowed = configuration.kind === "local"
    ? new Set(["http:", "https:"])
    : new Set(["https:"]);
  if (!allowed.has(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new ProviderConfigurationError(
      "INVALID_ENDPOINT",
      "Provider endpoint uses a disallowed protocol or embeds credentials.",
    );
  }
  if (configuration.kind === "local" && !isLoopback(endpoint.hostname)) {
    throw new ProviderConfigurationError(
      "INVALID_ENDPOINT",
      "Local provider endpoints must use a loopback hostname.",
    );
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
