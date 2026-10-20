import { MAX_ROUTE_PROVIDERS, MODEL_NAME, providerKind, resolveChatModel } from "./model-endpoint.mjs";
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

/**
 * The free-tier pool: hosted providers with a free allowance, each joined only
 * when the owner adds its key. Free allowances are per account and per day,
 * so stacking several turns "one provider ran out" into "the next one answers".
 * Each key goes only to its fixed origin (never to a configurable URL), and a
 * provider whose allowance cannot fit a request is skipped, never sent it.
 *
 * Gemini's and OpenRouter's free tiers may use prompts to improve their
 * models; chat can carry repository content, so adding those keys is the
 * owner's explicit choice (docs/FREE-TIER-PROVIDERS.md).
 */
const FREE_TIER_PROVIDERS = Object.freeze([
  // Per model: 1M tokens/day, 30k uncached input tokens/min, 5 requests/min. The free
  // window is held at 64k (smaller than the paid one), so larger requests skip ahead.
  { id: "cerebras", label: "Cerebras · gpt-oss-120b", baseUrl: "https://api.cerebras.ai/v1/", apiKey: (environment) => environment.CEREBRAS_API_KEY,
    model: "gpt-oss-120b", fallbackModel: null, capabilities: { tools: true, streaming: true, contextTokens: 65536 } },
  // About 40 requests/min shared by every model on the key, no daily token cap.
  { id: "nvidia", label: "NVIDIA · gpt-oss-120b", baseUrl: "https://integrate.api.nvidia.com/v1/", apiKey: (environment) => environment.NVIDIA_API_KEY,
    model: "openai/gpt-oss-120b", fallbackModel: null, capabilities: { tools: true, streaming: true, contextTokens: 131072 } },
  // Limits are per model, so the lite sibling still has room when Flash is spent. Aliases follow Google's current release.
  { id: "gemini", label: "Google Gemini Flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: (environment) => environment.GEMINI_API_KEY,
    model: "gemini-flash-latest", fallbackModel: "gemini-flash-lite-latest", capabilities: { tools: true, streaming: true } },
  // 20/min; 50/day per account, 1,000/day once the account has bought credits. Last of the free pool.
  { id: "openrouter", label: "OpenRouter · free models", baseUrl: "https://openrouter.ai/api/v1/", apiKey: (environment) => environment.OPENROUTER_API_KEY,
    model: "openai/gpt-oss-120b:free", fallbackModel: null, capabilities: { tools: true, streaming: true } },
]);
export const FREE_TIER_PROVIDER_IDS = Object.freeze(FREE_TIER_PROVIDERS.map((spec) => spec.id));

/**
 * ATLAS_PROVIDER_MODELS overrides a pool provider's model, e.g.
 * "cerebras=qwen-3-coder-480b, openrouter=qwen/qwen3-coder:free". Unknown
 * providers and names that do not look like model names are ignored.
 */
function providerModelOverrides(environment) {
  const overrides = new Map();
  for (const entry of (environment.ATLAS_PROVIDER_MODELS || "").split(",")) {
    const [id, model, extra] = entry.split("=");
    if (extra === undefined && FREE_TIER_PROVIDER_IDS.includes(id?.trim().toLowerCase()) && MODEL_NAME.test(model?.trim() ?? "")) overrides.set(id.trim().toLowerCase(), model.trim());
  }
  return overrides;
}

/** One pool provider, configured by its key alone; null without one. */
export function freeTierModel(id, environment = process.env) {
  const spec = FREE_TIER_PROVIDERS.find((candidate) => candidate.id === id);
  const apiKey = (spec?.apiKey(environment) || "").trim();
  if (!spec || !apiKey) return null;
  const override = providerModelOverrides(environment).get(id);
  const model = override ?? spec.model;
  // An overridden model may have another window; the default's limit would be wrong for it.
  const capabilities = override ? { tools: true, streaming: true } : spec.capabilities;
  const fallbackModel = spec.fallbackModel && spec.fallbackModel !== model ? spec.fallbackModel : null;
  return { configured: true, reason: undefined, provider: spec.id, baseUrl: spec.baseUrl, model, apiKey, fallbackModel, capabilities };
}

/** Every pool provider with a key, in route order. */
function freeTierModels(environment) {
  return FREE_TIER_PROVIDER_IDS.map((id) => freeTierModel(id, environment)).filter(Boolean);
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
  if (typeof selection === "string" && selection.startsWith("configured:")) {
    const model = selection.slice("configured:".length);
    if (!primary.configured || !primary.models.includes(model)) return { configured: false, reason: "Choose a configured model." };
    // An explicit model choice stays on that model; Automatic retains the pool.
    return { ...primary, model, models: [model], fallbackModel: null };
  }
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
  const pool = freeTierModels(environment);
  if (selection === "workers-ai") {
    if (!workers) return { configured: false, reason: "Workers AI is not configured: the Worker has no AI binding and no ATLAS_WORKERS_AI_TOKEN." };
    return fallbackDisabled ? workers : chain([workers, configured, groqModel(environment), ...pool, openai]);
  }
  if (FREE_TIER_PROVIDER_IDS.includes(selection)) {
    const chosen = pool.find((provider) => provider.provider === selection);
    if (!chosen) return { configured: false, reason: `${selection} is not configured. Add its API key to the Atlas Worker.` };
    // Selection sets the preferred provider; the rest of the route stays as recovery.
    return fallbackDisabled ? chosen : chain([chosen, configured, workers, groqModel(environment), ...pool, openai]);
  }
  if (!["auto", "configured"].includes(selection)) return { configured: false, reason: "Unknown model provider." };
  if (selection === "configured") return primary;
  // Invalid explicit endpoints remain errors; with no main model configured,
  // Workers AI, then the free-tier pool, then OpenAI leads.
  if (!configured && (environment.ATLAS_CHAT_BASE_URL || environment.ATLAS_CHAT_MODEL)) return primary;
  const lead = configured ?? workers ?? pool[0] ?? openai;
  if (!lead) return primary;
  if (fallbackDisabled) return lead;
  // Automatic: the main model, then Workers AI, Groq, the free-tier pool and,
  // last, paid OpenAI (a provider already in the route is not repeated), each
  // with its own fallback model.
  return chain([lead, workers, groqModel(environment), ...pool, openai]);
}

/** Automatic's route as provider kinds ("self-hosted", "workers-ai", "groq", "cerebras", …, "openai"), never addresses or keys. */
export function chatRoute(environment = process.env, bindings = {}) {
  const kinds = [];
  for (let provider = resolveChatProvider(environment, "auto", bindings); provider?.configured && kinds.length < MAX_ROUTE_PROVIDERS; provider = provider.providerFallback) kinds.push(providerKind(provider.baseUrl));
  return kinds;
}

export function chatProviderChoices(environment = process.env, bindings = {}) {
  return [
    { id: "auto", label: "Automatic", available: resolveChatProvider(environment, "auto", bindings).configured },
    { id: "configured", label: "Configured provider", available: resolveChatModel(environment).configured },
    ...(resolveChatModel(environment).models ?? []).map((model) => ({ id: `configured:${model}`, label: `Configured · ${model}`, available: true })),
    { id: "workers-ai", label: "Cloudflare Workers AI", available: Boolean(workersAIBindingModel(bindings, environment) ?? workersAIModel(environment)) },
    // Pool providers are listed only once their key is present.
    ...FREE_TIER_PROVIDERS.filter((spec) => freeTierModel(spec.id, environment)).map((spec) => ({ id: spec.id, label: spec.label, available: true })),
    { id: "openai", label: "OpenAI · GPT-5.4 mini", available: Boolean(openAIModel(environment)), paid: true },
  ];
}
