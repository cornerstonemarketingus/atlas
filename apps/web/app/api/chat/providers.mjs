import { providerKind, resolveChatModel } from "./model-endpoint.mjs";
import { workersAIBindingModel } from "./workers-ai-binding.mjs";

// Dedicated credentials only ever travel to this fixed OpenAI API origin.
export function openAIModel(environment = process.env) {
  const apiKey = (environment.OPENAI_API_KEY || "").trim();
  return apiKey ? { configured: true, reason: undefined, provider: "openai", baseUrl: "https://api.openai.com/v1/",
    model: "gpt-5.4-mini", apiKey, fallbackModel: null } : null;
}

/**
 * Groq as a fallback, when the configured model is somewhere else (a model on
 * the owner's machine, behind the model gateway) and a Groq key reaches the
 * Worker: chat keeps answering while that machine is off or busy.
 */
export function groqModel(environment = process.env) {
  const apiKey = (environment.GROQ_API_KEY || "").trim();
  return apiKey ? { configured: true, reason: undefined, provider: "groq", baseUrl: "https://api.groq.com/openai/v1/",
    model: "openai/gpt-oss-120b", apiKey, fallbackModel: "openai/gpt-oss-20b",
    // gpt-oss-120b/20b: 131,072-token context, tool calls and streaming. A request that cannot fit is not sent.
    capabilities: { tools: true, streaming: true, contextTokens: 131072 } } : null;
}

/**
 * Cloudflare Workers AI: models served by the same Cloudflare account that runs
 * Atlas, through its OpenAI-compatible endpoint, so chat needs neither Groq nor
 * a model on the owner's machine. The token (Workers AI permission only) is
 * sent only to the fixed Cloudflare API origin, for the configured account.
 */
const WORKERS_AI_DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";
const WORKERS_AI_SIBLING_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export function workersAIModel(environment = process.env) {
  const apiKey = (environment.ATLAS_WORKERS_AI_TOKEN || "").trim();
  const account = (environment.CLOUDFLARE_ACCOUNT_ID || "").trim().toLowerCase();
  if (!apiKey || !/^[0-9a-f]{32}$/u.test(account)) return null;
  const model = (environment.ATLAS_WORKERS_AI_MODEL || "").trim() || WORKERS_AI_DEFAULT_MODEL;
  return { configured: true, reason: undefined, provider: "workers-ai", baseUrl: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/`,
    model, apiKey, fallbackModel: model === WORKERS_AI_SIBLING_MODEL ? null : WORKERS_AI_SIBLING_MODEL,
    capabilities: { tools: true, streaming: true } };
}

/** One provider per origin, first wins, each one's providerFallback the next. */
function chain(providers) {
  const seen = new Set();
  const unique = providers.filter((provider) => {
    if (!provider) return false;
    const origin = new URL(provider.baseUrl).origin;
    if (seen.has(origin)) return false;
    seen.add(origin);
    return true;
  });
  return unique.reduceRight((next, provider) => ({ ...provider, ...(next ? { providerFallback: next } : {}) }), null);
}

/** Only server-owned provider IDs may be selected, never client endpoints or keys. */
/**
 * `bindings.ai` is the Worker's Workers AI binding: when present it is the
 * Workers AI provider (no token, always this account), ahead of the
 * token-based REST endpoint.
 */
export function resolveChatProvider(environment = process.env, selection = "auto", bindings = {}) {
  const openai = openAIModel(environment);
  const primary = resolveChatModel(environment);
  if (primary.configured && new URL(primary.baseUrl).origin === "https://api.openai.com" && openai && !primary.apiKey) primary.apiKey = openai.apiKey;
  const fallbackDisabled = (environment.ATLAS_CHAT_FALLBACK_MODEL || "").trim().toLowerCase() === "none";
  if (selection === "openai") {
    if (!openai) return { configured: false, reason: "OpenAI is not configured. Add OPENAI_API_KEY to the Atlas Worker." };
    // Selection establishes the preferred provider; a temporary refusal must not
    // discard the already configured recovery route. Never cycle to OpenAI again.
    return { ...openai, ...(!fallbackDisabled && primary.configured && new URL(primary.baseUrl).origin !== "https://api.openai.com" ? { providerFallback: primary } : {}) };
  }
  const workers = workersAIBindingModel(bindings, environment) ?? workersAIModel(environment);
  const configured = primary.configured ? primary : null;
  if (selection === "workers-ai") {
    if (!workers) return { configured: false, reason: "Workers AI is not configured: the Worker has no AI binding and no ATLAS_WORKERS_AI_TOKEN." };
    return fallbackDisabled ? workers : chain([workers, configured, groqModel(environment), openai]);
  }
  if (!["auto", "configured"].includes(selection)) return { configured: false, reason: "Unknown model provider." };
  if (selection === "configured") return primary;
  // Invalid explicit endpoints remain errors; with no main model configured,
  // Workers AI (then OpenAI) leads.
  if (!configured && (environment.ATLAS_CHAT_BASE_URL || environment.ATLAS_CHAT_MODEL)) return primary;
  const lead = configured ?? workers ?? openai;
  if (!lead) return primary;
  if (fallbackDisabled) return lead;
  // Automatic: the main model, then Workers AI, Groq and OpenAI (a provider
  // already in the route is not repeated), each with its own fallback model.
  return chain([lead, workers, groqModel(environment), openai]);
}

/** Automatic's route as provider kinds ("self-hosted", "workers-ai", "groq", "openai"), never addresses or keys. */
export function chatRoute(environment = process.env, bindings = {}) {
  const kinds = [];
  for (let provider = resolveChatProvider(environment, "auto", bindings); provider?.configured && kinds.length < 5; provider = provider.providerFallback) kinds.push(providerKind(provider.baseUrl));
  return kinds;
}

export function chatProviderChoices(environment = process.env, bindings = {}) {
  return [
    { id: "auto", label: "Automatic", available: resolveChatProvider(environment, "auto", bindings).configured },
    { id: "configured", label: "Configured provider", available: resolveChatModel(environment).configured },
    { id: "workers-ai", label: "Cloudflare Workers AI", available: Boolean(workersAIBindingModel(bindings, environment) ?? workersAIModel(environment)) },
    { id: "openai", label: "OpenAI · GPT-5.4 mini", available: Boolean(openAIModel(environment)), paid: true },
  ];
}
