/**
 * Where a chat turn is sent, and whether it may be sent at all.
 *
 * Atlas talks to an OpenAI-compatible chat-completions server — Ollama,
 * vLLM, llama.cpp, LM Studio, or a hosted provider. Nothing here names a
 * vendor; the deployment picks one. Chat configuration is intentionally
 * explicit: GitHub Actions variables used by the coder runner are not
 * available inside a deployed Worker.
 *
 *   - HTTPS is required for any remote host. A chat turn can carry whatever
 *     the user pasted into it; sending that in clear text would undo every
 *     other precaution.
 *   - Loopback may use plain HTTP, because a request that never leaves the
 *     machine has no network to be intercepted on, and demanding a
 *     certificate for `localhost` only teaches people to disable TLS checks.
 *   - No credentials in the URL. They would land in error messages and logs,
 *     neither of which redacts a hostname. Keys go in the key variable.
 *
 * When nothing is configured this returns `configured: false` with a reason
 * the interface can show. Atlas says it has no model rather than inventing a
 * reply, for the same reason it never invents a preview URL.
 */

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

/** @returns {{ configured: boolean, reason?: string, baseUrl?: string, model?: string, apiKey?: string|null }} */
export function resolveChatModel(environment = process.env) {
  const baseUrl = (environment.ATLAS_CHAT_BASE_URL || "").trim();
  const model = (environment.ATLAS_CHAT_MODEL || "").trim();
  let apiKey = (environment.ATLAS_MODEL_API_KEY || "").trim();

  if (!baseUrl || !model) {
    return {
      configured: false,
      reason: "Chat needs a model endpoint. Set ATLAS_CHAT_BASE_URL and ATLAS_CHAT_MODEL to any OpenAI-compatible server — see Connections.",
    };
  }

  let url;
  try {
    url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    return { configured: false, reason: "The configured model endpoint is not a valid URL." };
  }
  if (url.username || url.password) {
    return { configured: false, reason: "The model endpoint must not carry credentials in its URL. Put the key in ATLAS_MODEL_API_KEY instead." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) {
    return { configured: false, reason: "A model endpoint must use HTTPS unless it is loopback." };
  }

  if (url.search || url.hash) return { configured: false, reason: "The model endpoint must not contain a query or fragment." };
  if (!apiKey && url.origin === "https://api.groq.com") apiKey = (environment.GROQ_API_KEY || "").trim();
  return { configured: true, baseUrl: url.toString(), model, apiKey: apiKey || null };
}

/** The absolute chat-completions URL for a resolved endpoint. */
export function completionsUrl(baseUrl) {
  return new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

/** Server-owned choices. Browser requests select an id, never a URL or key. */
export function chatModelOptions(environment = process.env) {
  if (environment.ATLAS_CHAT_PROFILES) {
    let profiles;
    try { profiles = JSON.parse(environment.ATLAS_CHAT_PROFILES); }
    catch { return { options: [], reason: "ATLAS_CHAT_PROFILES must be a JSON array." }; }
    if (!Array.isArray(profiles) || !profiles.length || profiles.length > 20) {
      return { options: [], reason: "Configure between 1 and 20 chat profiles." };
    }
    const options = [];
    for (const profile of profiles) {
      if (!profile || typeof profile.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/u.test(profile.id)
        || options.some((option) => option.id === profile.id)
        || typeof profile.model !== "string" || typeof profile.baseUrl !== "string"
        || (profile.reasoningEffort !== undefined && !["none", "low", "medium", "high"].includes(profile.reasoningEffort))
        || (profile.apiKeyEnv !== undefined && (typeof profile.apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(profile.apiKeyEnv)))) {
        return { options: [], reason: "Chat profiles need unique ids, model names, valid endpoints, and optional API key variable names." };
      }
      const endpoint = resolveChatModel({
        ATLAS_CHAT_BASE_URL: profile.baseUrl, ATLAS_CHAT_MODEL: profile.model,
        ATLAS_MODEL_API_KEY: profile.apiKeyEnv ? environment[profile.apiKeyEnv] : "",
      });
      if (!endpoint.configured) return { options: [], reason: endpoint.reason };
      if (profile.apiKeyEnv && !endpoint.apiKey) return { options: [], reason: `Set the API key variable for chat profile ${profile.id}.` };
      options.push({ ...endpoint, id: profile.id, label: typeof profile.label === "string" ? profile.label.slice(0, 100) : profile.model, reasoningEffort: profile.reasoningEffort });
    }
    return { options, reason: null };
  }
  const endpoint = resolveChatModel(environment);
  if (!endpoint.configured) return { options: [], reason: endpoint.reason };
  const models = [...new Set([endpoint.model, ...(environment.ATLAS_CHAT_MODELS || "").split(",").map((name) => name.trim()).filter(Boolean)])].slice(0, 20);
  return { options: models.map((model) => ({ ...endpoint, model, id: model, label: model })), reason: null };
}

/** @returns {{ configured: boolean, reason?: string|null, invalidSelection?: boolean, id?: string, label?: string, baseUrl?: string, model?: string, apiKey?: string|null, reasoningEffort?: string }} */
export function selectChatModel(environment = process.env, id) {
  const { options, reason } = chatModelOptions(environment);
  if (!options.length) return { configured: false, reason };
  const selected = id === undefined ? options[0] : options.find((option) => option.id === id);
  return selected ?? { configured: false, reason: "Choose a configured chat model.", invalidSelection: true };
}

/** Safe to return to clients: never includes credentials or endpoint URLs. */
export function publicChatModels(environment = process.env) {
  const { options, reason } = chatModelOptions(environment);
  return { configured: options.length > 0, reason, models: options.map(({ id, label, model }) => ({ id, label, model })), defaultModel: options[0]?.id ?? null };
}

export function chatRequestBody(endpoint, messages, maxTokens = 1200) {
  return { model: endpoint.model, messages, stream: false, temperature: 0.2, max_tokens: maxTokens,
    ...(endpoint.reasoningEffort ? { reasoning_effort: endpoint.reasoningEffort } : {}) };
}

/**
 * Pulls the assistant text out of a chat-completions response, tolerating the
 * shape differences between servers. Reasoning fields are deliberately ignored:
 * raw chain-of-thought is not shown to a user.
 */
export function replyText(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : null;
  if (typeof content === "string") return content.trim();
  // Some servers return content as an array of parts.
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("").trim();
  }
  return "";
}

/** A short, stable thread title derived from the first thing the user said. */
export function threadTitle(message) {
  const flattened = message.replace(/\s+/gu, " ").trim();
  return flattened.length > 72 ? `${flattened.slice(0, 71)}…` : flattened;
}
