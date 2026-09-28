import { resolveChatModel } from "./model-endpoint.mjs";

// Dedicated credentials only ever travel to this fixed OpenAI API origin.
export function openAIModel(environment = process.env) {
  const apiKey = (environment.OPENAI_API_KEY || "").trim();
  return apiKey ? { configured: true, reason: undefined, provider: "openai", baseUrl: "https://api.openai.com/v1/",
    model: "gpt-5.4-mini", apiKey, fallbackModel: null } : null;
}

/** Only server-owned provider IDs may be selected, never client endpoints or keys. */
export function resolveChatProvider(environment = process.env, selection = "auto") {
  const openai = openAIModel(environment);
  const primary = resolveChatModel(environment);
  if (primary.configured && new URL(primary.baseUrl).origin === "https://api.openai.com" && openai && !primary.apiKey) primary.apiKey = openai.apiKey;
  if (selection === "openai") return openai ?? { configured: false, reason: "OpenAI is not configured. Add OPENAI_API_KEY to the Atlas Worker." };
  if (!["auto", "configured"].includes(selection)) return { configured: false, reason: "Unknown model provider." };
  if (selection === "configured") return primary;
  // Invalid explicit endpoints remain errors; missing primary configuration can use OpenAI alone.
  if (!primary.configured) return !environment.ATLAS_CHAT_BASE_URL && !environment.ATLAS_CHAT_MODEL && openai ? openai : primary;
  const fallbackDisabled = (environment.ATLAS_CHAT_FALLBACK_MODEL || "").trim().toLowerCase() === "none";
  return { ...primary, ...(!fallbackDisabled && openai && new URL(primary.baseUrl).origin !== "https://api.openai.com" ? { providerFallback: openai } : {}) };
}

export function chatProviderChoices(environment = process.env) {
  return [
    { id: "auto", label: "Automatic", available: resolveChatProvider(environment).configured },
    { id: "configured", label: "Configured provider", available: resolveChatModel(environment).configured },
    { id: "openai", label: "OpenAI · GPT-5.4 mini", available: Boolean(openAIModel(environment)), paid: true },
  ];
}
