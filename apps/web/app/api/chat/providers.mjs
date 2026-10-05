import { resolveChatModel } from "./model-endpoint.mjs";

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
    model: "openai/gpt-oss-120b", apiKey, fallbackModel: "openai/gpt-oss-20b" } : null;
}

/** Only server-owned provider IDs may be selected, never client endpoints or keys. */
export function resolveChatProvider(environment = process.env, selection = "auto") {
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
  if (!["auto", "configured"].includes(selection)) return { configured: false, reason: "Unknown model provider." };
  if (selection === "configured") return primary;
  // Invalid explicit endpoints remain errors; missing primary configuration can use OpenAI alone.
  if (!primary.configured) return !environment.ATLAS_CHAT_BASE_URL && !environment.ATLAS_CHAT_MODEL && openai ? openai : primary;
  if (fallbackDisabled) return primary;
  // Automatic: the configured model, then Groq (unless it is the configured
  // provider), then OpenAI (unless it is), each with its own fallback model.
  const origin = new URL(primary.baseUrl).origin;
  const groq = origin !== "https://api.groq.com" ? groqModel(environment) : null;
  const last = origin !== "https://api.openai.com" ? openai : null;
  const second = groq ? { ...groq, ...(last ? { providerFallback: last } : {}) } : last;
  return { ...primary, ...(second ? { providerFallback: second } : {}) };
}

export function chatProviderChoices(environment = process.env) {
  return [
    { id: "auto", label: "Automatic", available: resolveChatProvider(environment).configured },
    { id: "configured", label: "Configured provider", available: resolveChatModel(environment).configured },
    { id: "openai", label: "OpenAI · GPT-5.4 mini", available: Boolean(openAIModel(environment)), paid: true },
  ];
}
