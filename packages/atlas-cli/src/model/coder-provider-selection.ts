/**
 * Chooses which remote model provider the `code` command talks to.
 *
 * This is pure so the decision can be tested without a network or an API key:
 * every branch below changes which vendor receives a customer's repository
 * content, which is exactly the kind of decision that should not first be
 * observable in production.
 */

export type CoderProviderId = "anthropic" | "groq";

export interface CoderProviderProfile {
  readonly providerId: CoderProviderId;
  readonly displayName: string;
  /** Used when `--api-key-env` is omitted. */
  readonly defaultApiKeyEnvironmentVariable: string;
  readonly contextWindowTokens: number;
  /**
   * Ceiling on `max_tokens` for a single turn, independent of the session's
   * total token budget.
   */
  readonly maxOutputTokensPerTurn: number;
}

const PROFILES: Readonly<Record<CoderProviderId, CoderProviderProfile>> = {
  groq: {
    providerId: "groq",
    displayName: "Groq",
    defaultApiKeyEnvironmentVariable: "GROQ_API_KEY",
    contextWindowTokens: 128_000,
    // Capped well under 8,192: Groq rejects a request outright (HTTP 413) once
    // prompt tokens + max_tokens exceeds its tokens-per-minute limit for a
    // model, and that limit can be as low as ~10,000 on shared/free tiers — a
    // naive 8,192 leaves almost no room for the prompt itself, let alone the
    // conversation history that accumulates over later turns.
    maxOutputTokensPerTurn: 1_024,
  },
  anthropic: {
    providerId: "anthropic",
    displayName: "Anthropic",
    defaultApiKeyEnvironmentVariable: "ANTHROPIC_API_KEY",
    // The conservative figure across the models in DEFAULT_ANTHROPIC_MODELS,
    // so a smaller model is never handed a request its window cannot hold.
    contextWindowTokens: 200_000,
    // Anthropic bills per token and has no per-minute cap that a large
    // max_tokens trips, so the limit here is about the coder loop rather than
    // the vendor: one turn should not be able to consume a whole session
    // budget, and a proposed file edit that needs more than this is a sign
    // the change wants splitting.
    maxOutputTokensPerTurn: 8_192,
  },
};

export const CODER_PROVIDER_IDS: readonly CoderProviderId[] = ["anthropic", "groq"];

export function isCoderProviderId(value: string): value is CoderProviderId {
  return value === "anthropic" || value === "groq";
}

/**
 * Infers the vendor from the model identifier when `--provider` is omitted.
 *
 * Model namespaces do not overlap between these vendors — Groq does not serve
 * Claude and Anthropic does not serve Llama — so this is a safe default rather
 * than a guess, and it keeps `--model claude-sonnet-5` working without a
 * second flag. Anything unrecognised falls back to Groq, which is what every
 * existing caller (including the workflow) already means.
 */
export function inferCoderProviderId(model: string): CoderProviderId {
  return /^(anthropic\/)?claude[-.]/iu.test(model.trim()) ? "anthropic" : "groq";
}

export interface CoderProviderSelectionInput {
  /** Raw `--provider` value, or undefined when the flag was not passed. */
  readonly provider?: string | undefined;
  readonly model: string;
  /** Raw `--api-key-env` value, or undefined when the flag was not passed. */
  readonly apiKeyEnvironmentVariable?: string | undefined;
  readonly tokenBudget: number;
}

export interface CoderProviderSelection {
  readonly profile: CoderProviderProfile;
  readonly apiKeyEnvironmentVariable: string;
  /** Already reduced to fit the session budget. */
  readonly maxOutputTokensPerTurn: number;
  /** True when the vendor came from the model name rather than an explicit flag. */
  readonly inferred: boolean;
}

export type CoderProviderSelectionResult =
  | { readonly ok: true; readonly selection: CoderProviderSelection }
  | { readonly ok: false; readonly message: string };

export function selectCoderProvider(input: CoderProviderSelectionInput): CoderProviderSelectionResult {
  const requested = input.provider?.trim();
  let providerId: CoderProviderId;
  let inferred: boolean;
  if (requested === undefined || requested.length === 0) {
    providerId = inferCoderProviderId(input.model);
    inferred = true;
  } else if (isCoderProviderId(requested)) {
    providerId = requested;
    inferred = false;
  } else {
    return {
      ok: false,
      message: `Unknown --provider '${requested}'. Expected one of: ${CODER_PROVIDER_IDS.join(", ")}.`,
    };
  }

  const profile = PROFILES[providerId];
  const requestedKeyEnv = input.apiKeyEnvironmentVariable?.trim() ?? "";
  const apiKeyEnvironmentVariable =
    requestedKeyEnv.length > 0 ? requestedKeyEnv : profile.defaultApiKeyEnvironmentVariable;

  if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 1) {
    return { ok: false, message: "--token-budget must be a positive integer." };
  }

  return {
    ok: true,
    selection: {
      profile,
      apiKeyEnvironmentVariable,
      maxOutputTokensPerTurn: Math.min(profile.maxOutputTokensPerTurn, input.tokenBudget),
      inferred,
    },
  };
}
