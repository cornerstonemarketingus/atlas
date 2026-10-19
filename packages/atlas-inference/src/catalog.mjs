/**
 * Every hosted model vendor Atlas can route to, described once: where it
 * lives, which variable holds its key, its default models, and who may see
 * what is sent to it (docs/atlas-os/INFERENCE-FABRIC.md).
 *
 * Trust tiers:
 *   private — the owner's own hardware or cloud account (configured
 *             endpoints, not listed here); may receive anything.
 *   vendor  — paid or no-training terms; may receive anything.
 *   trains  — free tiers whose terms allow using prompts to improve the
 *             vendor's products. Off unless the owner opts in, never given
 *             tool results, workspace memory or code, never used by the coder.
 *
 * Free terms change without notice; the dates say when these were checked.
 * Model names can be overridden per vendor (ATLAS_<VENDOR>_MODEL), and a
 * vendor whose model has gone answers 404, which the router treats as "use
 * the next one".
 */
export const TRUST = Object.freeze({ PRIVATE: "private", VENDOR: "vendor", TRAINS: "trains" });

export const VENDORS = Object.freeze({
  groq: Object.freeze({
    id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1/", keyVariable: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b", fallbackModel: "openai/gpt-oss-20b", tier: TRUST.VENDOR,
    capabilities: Object.freeze({ tools: true, streaming: true, contextTokens: 131072 }),
  }),
  // Checked 2026-10-19: a $5 trial after adding a card, ~1M tokens/day, 5 RPM on gpt-oss-120b.
  cerebras: Object.freeze({
    id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1/", keyVariable: "CEREBRAS_API_KEY",
    model: "gpt-oss-120b", fallbackModel: null, tier: TRUST.VENDOR,
    capabilities: Object.freeze({ tools: true, streaming: true, contextTokens: 65536 }),
  }),
  // Checked 2026-10-19: free tier is Flash-only, per-project limits; free-tier content is used to improve Google's products.
  gemini: Object.freeze({
    id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", keyVariable: "GEMINI_API_KEY",
    model: "gemini-2.5-flash", fallbackModel: "gemini-2.5-flash-lite", tier: TRUST.TRAINS,
    capabilities: Object.freeze({ tools: true, streaming: true, contextTokens: 1048576 }),
  }),
  // Checked 2026-10-19: ":free" routes allow 20 RPM and 50 requests/day (1,000/day after $10 of credits once).
  openrouter: Object.freeze({
    id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1/", keyVariable: "OPENROUTER_API_KEY",
    model: "openai/gpt-oss-20b:free", fallbackModel: null, tier: TRUST.TRAINS,
    capabilities: Object.freeze({ tools: true, streaming: true, contextTokens: 131072 }),
  }),
  // Checked 2026-10-19: free accounts get monthly credits; limits are shown only in the console.
  mistral: Object.freeze({
    id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1/", keyVariable: "MISTRAL_API_KEY",
    model: "mistral-small-latest", fallbackModel: null, tier: TRUST.TRAINS,
    capabilities: Object.freeze({ tools: true, streaming: true, contextTokens: 131072 }),
  }),
});

const NAME = /^[A-Za-z0-9@._:/-]{1,128}$/u;

/** The tier a vendor has for this deployment: `ATLAS_<VENDOR>_TIER=paid` moves a training tier to vendor terms. */
export function vendorTier(vendor, environment = {}) {
  if (vendor.tier !== TRUST.TRAINS) return vendor.tier;
  return (environment[`ATLAS_${vendor.id.toUpperCase()}_TIER`] || "").trim().toLowerCase() === "paid" ? TRUST.VENDOR : TRUST.TRAINS;
}

/** Whether the owner allows free tiers that may train on prompts at all. */
export function trainingProvidersAllowed(environment = {}) {
  return (environment.ATLAS_ALLOW_TRAINING_PROVIDERS || "").trim() === "1";
}

/**
 * A configured vendor as a chat endpoint (the shape the chat router uses), or
 * null when its key is missing, or when it is a training tier the owner has
 * not allowed. Keys only ever travel to the vendor's fixed origin.
 */
export function vendorEndpoint(id, environment = {}) {
  const vendor = VENDORS[id];
  if (!vendor) return null;
  const apiKey = (environment[vendor.keyVariable] || "").trim();
  if (!apiKey) return null;
  const tier = vendorTier(vendor, environment);
  if (tier === TRUST.TRAINS && !trainingProvidersAllowed(environment)) return null;
  const override = (environment[`ATLAS_${id.toUpperCase()}_MODEL`] || "").trim();
  const model = NAME.test(override) ? override : vendor.model;
  return {
    configured: true, reason: undefined, provider: id, baseUrl: vendor.baseUrl, model, apiKey,
    fallbackModel: model === vendor.model ? vendor.fallbackModel : null, tier, capabilities: { ...vendor.capabilities },
  };
}

/**
 * Whether a request may go to a `trains` tier: nothing in it came from a tool
 * (repository files, web pages, run output), from workspace memory, or looks
 * like code. What remains is the system prompt and the person's own words.
 */
export function qualifiesForTraining(messages = []) {
  return messages.every((message) => {
    if (message.role === "tool" || (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length)) return false;
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    if (/<data\b/iu.test(content)) return false;
    // Atlas's own system prompt may show examples; the conversation may not carry code.
    return message.role === "system" || !content.includes("```");
  });
}
