/**
 * Chooses which remote model provider the `code` command talks to.
 *
 * This is pure so the decision can be tested without a network or an API key:
 * every branch below changes which vendor receives a customer's repository
 * content, which is exactly the kind of decision that should not first be
 * observable in production.
 */

export type CoderProviderId = "local" | "anthropic" | "ollama" | "groq" | "openai" | "workers-ai" | "cerebras" | "gemini" | "openrouter" | "mistral";

export interface CoderProviderProfile {
  readonly providerId: CoderProviderId;
  readonly displayName: string;
  /** Used when `--api-key-env` is omitted. Empty for a provider that takes no key. */
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
  // A server you run: keyless, and the window is whatever --context-window declares.
  ollama: { providerId: "ollama", displayName: "Ollama (local)", defaultApiKeyEnvironmentVariable: "", contextWindowTokens: 16_384, maxOutputTokensPerTurn: 2_048 },
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

export const CODER_PROVIDER_IDS: readonly CoderProviderId[] = ["local", "anthropic", "groq", "openai", "workers-ai", "cerebras", "gemini", "openrouter", "mistral", "ollama"];

/** Providers that run on a machine the operator controls and need no credential. */
export function isKeylessCoderProvider(providerId: CoderProviderId): boolean {
  return PROFILES[providerId].defaultApiKeyEnvironmentVariable === "";
}

export function isCoderProviderId(value: string): value is CoderProviderId {
  return (CODER_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Model names only Groq's hosted catalog uses (its `vendor/model` ids and its
 * own `-versatile`/`-instant` aliases). An Ollama tag never looks like these:
 * Ollama names a size after a colon (`llama3.1:8b`).
 */
const GROQ_CATALOG = /^(?:groq\/|openai\/gpt-oss-|moonshotai\/|meta-llama\/|qwen\/|deepseek-ai\/|allam-|compound(?:-|$)|llama-3\.\d+-\d+b-(?:versatile|instant)|llama3-\d+b-\d+|gemma2-\d+b-it$|mixtral-8x7b-32768$|deepseek-r1-distill-)/iu;

export interface CoderProviderInferenceContext {
  /** True when `--base-url` / ATLAS_CODER_BASE_URL names a server the operator runs. */
  readonly customEndpoint?: boolean;
}

/**
 * Infers the provider from the model identifier when `--provider` is omitted.
 *
 * A hosted vendor is inferred only from a name that vendor alone uses
 * (`claude-*`, `gpt-*`, `gemini-*`, `@cf/...`, `...:free`, Groq's catalog
 * ids), so naming the model is naming the vendor. Anything else is a model on
 * the operator's own machine: the local Ollama, or the OpenAI-compatible
 * server `--base-url` names. An unrecognised name never sends a repository to
 * a hosted vendor just because that vendor's key happens to be set.
 */
export function inferCoderProviderId(model: string, context: CoderProviderInferenceContext = {}): CoderProviderId {
  const name = model.trim();
  if (name.startsWith("@cf/")) return "workers-ai";
  if (name.endsWith(":free")) return "openrouter";
  if (/^ft:/iu.test(name)) return "openai";
  // An Ollama tag (`gpt-oss:20b`, `mistral-small:24b`, `qwen2.5-coder:7b`): no
  // hosted vendor names its models with a size or quantisation after a colon.
  if (/^[^:]+:[^:]+$/u.test(name)) return context.customEndpoint === true ? "groq" : "ollama";
  if (/^gemini-/iu.test(name)) return "gemini";
  if (/^(?:mistral|devstral|codestral|magistral)-/iu.test(name)) return "mistral";
  if (/^(?:gpt-|o[134](?:-|$))/iu.test(name)) return "openai";
  if (/^(anthropic\/)?claude[-.]/iu.test(name)) return "anthropic";
  if (GROQ_CATALOG.test(name)) return "groq";
  // The OpenAI-compatible client at the operator's own --base-url (vLLM, llama.cpp, LM Studio).
  if (context.customEndpoint === true) return "groq";
  return "ollama";
}

/** Providers whose requests leave the machine unless --base-url points them at loopback. */
export function isHostedCoderProvider(providerId: CoderProviderId): boolean {
  return providerId !== "ollama" && providerId !== "local";
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
  /** True when a --base-url was given; an unrecognised model then means that server, not Ollama. */
  readonly customEndpoint?: boolean | undefined;
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
    providerId = inferCoderProviderId(input.model, { customEndpoint: input.customEndpoint === true });
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
