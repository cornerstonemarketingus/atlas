/**
 * Chooses which remote model provider the `code` command talks to.
 *
 * This is pure so the decision can be tested without a network or an API key:
 * every branch below changes which vendor receives a customer's repository
 * content, which is exactly the kind of decision that should not first be
 * observable in production.
 */

export type CoderProviderId = "local" | "anthropic" | "groq" | "openai" | "workers-ai" | "cerebras" | "gemini" | "openrouter" | "mistral";

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
  local: { providerId: "local", displayName: "Local OpenAI-compatible model", defaultApiKeyEnvironmentVariable: "ATLAS_LOCAL_MODEL_KEY", contextWindowTokens: 16_384, maxOutputTokensPerTurn: 2_048 },
  openai: { providerId: "openai", displayName: "OpenAI", defaultApiKeyEnvironmentVariable: "OPENAI_API_KEY", contextWindowTokens: 128_000, maxOutputTokensPerTurn: 8_192 },
  "workers-ai": { providerId: "workers-ai", displayName: "Cloudflare Workers AI", defaultApiKeyEnvironmentVariable: "ATLAS_WORKERS_AI_TOKEN", contextWindowTokens: 131_072, maxOutputTokensPerTurn: 8_192 },
  // OpenAI-compatible vendors at fixed origins (packages/atlas-inference/src/catalog.mjs).
  cerebras: { providerId: "cerebras", displayName: "Cerebras", defaultApiKeyEnvironmentVariable: "CEREBRAS_API_KEY", contextWindowTokens: 65_536, maxOutputTokensPerTurn: 8_192 },
  gemini: { providerId: "gemini", displayName: "Google Gemini", defaultApiKeyEnvironmentVariable: "GEMINI_API_KEY", contextWindowTokens: 1_048_576, maxOutputTokensPerTurn: 8_192 },
  openrouter: { providerId: "openrouter", displayName: "OpenRouter", defaultApiKeyEnvironmentVariable: "OPENROUTER_API_KEY", contextWindowTokens: 131_072, maxOutputTokensPerTurn: 8_192 },
  mistral: { providerId: "mistral", displayName: "Mistral", defaultApiKeyEnvironmentVariable: "MISTRAL_API_KEY", contextWindowTokens: 131_072, maxOutputTokensPerTurn: 8_192 },
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
    // This is a per-turn output ceiling, not an exemption from Anthropic's
    // account-specific request/input/output rate limits. Large edits should
    // still be split to leave room in the session budget.
    maxOutputTokensPerTurn: 8_192,
  },
};

export const CODER_PROVIDER_IDS: readonly CoderProviderId[] = ["local", "anthropic", "groq", "openai", "workers-ai", "cerebras", "gemini", "openrouter", "mistral"];

export function isCoderProviderId(value: string): value is CoderProviderId {
  return (CODER_PROVIDER_IDS as readonly string[]).includes(value);
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
  const name = model.trim();
  if (name.startsWith("@cf/")) return "workers-ai";
  if (name.endsWith(":free")) return "openrouter";
  if (/^gemini-/iu.test(name)) return "gemini";
  if (/^(?:mistral|devstral|codestral|magistral)-/iu.test(name)) return "mistral";
  if (/^(?:gpt-|o[134](?:-|$))/iu.test(name)) return "openai";
  return /^(anthropic\/)?claude[-.]/iu.test(name) ? "anthropic" : "groq";
}

export interface CoderProviderSelectionInput {
  /** Raw `--provider` value, or undefined when the flag was not passed. */
  readonly provider?: string | undefined;
  readonly model: string;
  /** Raw `--api-key-env` value, or undefined when the flag was not passed. */
  readonly apiKeyEnvironmentVariable?: string | undefined;
  readonly tokenBudget: number;
  /**
   * Replaces the provider's per-turn output ceiling. Groq's default of 1,024
   * suits its free tier; a paid tier has the headroom for full-file edits.
   */
  readonly outputTokensPerTurn?: number | undefined;
}

/** Bounds for an operator-chosen per-turn output ceiling. */
export const OUTPUT_TOKENS_PER_TURN_RANGE = Object.freeze({ minimum: 256, maximum: 32_768 });

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
  const override = input.outputTokensPerTurn;
  if (override !== undefined && (!Number.isSafeInteger(override)
    || override < OUTPUT_TOKENS_PER_TURN_RANGE.minimum || override > OUTPUT_TOKENS_PER_TURN_RANGE.maximum)) {
    return {
      ok: false,
      message: `--output-tokens-per-turn must be an integer between ${OUTPUT_TOKENS_PER_TURN_RANGE.minimum} and ${OUTPUT_TOKENS_PER_TURN_RANGE.maximum}.`,
    };
  }

  return {
    ok: true,
    selection: {
      profile,
      apiKeyEnvironmentVariable,
      maxOutputTokensPerTurn: Math.min(override ?? profile.maxOutputTokensPerTurn, input.tokenBudget),
      inferred,
    },
  };
}
