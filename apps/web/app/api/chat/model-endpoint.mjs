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

/**
 * A second model on the same endpoint for when the first is rate-limited.
 * Providers such as Groq limit each model separately, so a smaller sibling
 * usually still has room. ATLAS_CHAT_FALLBACK_MODEL sets it ("none" turns it
 * off); on Groq it defaults to openai/gpt-oss-20b, which Atlas's coder
 * already uses as its fallback.
 */
function fallbackModelFor(environment, url, model) {
  const configured = (environment.ATLAS_CHAT_FALLBACK_MODEL || "").trim();
  if (configured.toLowerCase() === "none") return null;
  const fallback = configured || (url.origin === "https://api.groq.com" ? "openai/gpt-oss-20b" : "");
  return fallback && fallback !== model ? fallback : null;
}

/** @returns {{ configured: boolean, reason?: string, baseUrl?: string, model?: string, apiKey?: string|null, fallbackModel?: string|null }} */
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
  const primary = { baseUrl: url.toString(), model, apiKey: apiKey || null, fallbackModel: fallbackModelFor(environment, url, model) };
  try {
    return { configured: true, ...primary, ...recoveryConfiguration(environment, primary) };
  } catch {
    // Never echo configuration: it can contain accidentally pasted credentials.
    return { configured: false, reason: "Invalid chat recovery configuration. Check ATLAS_CHAT_TARGETS, ATLAS_CHAT_TARGET_ORDER and recovery policy settings." };
  }
}

/** Validate every target through the same endpoint rules; credentials never inherit across targets. */
function recoveryConfiguration(environment, primary) {
  const policy = environment.ATLAS_CHAT_ROUTING_POLICY || "BALANCED";
  if (!["LOCAL_ONLY", "PREFER_LOCAL", "BALANCED", "BEST_AVAILABLE"].includes(policy)) throw new Error("policy");
  const maxCostMicroUsd = Number(environment.ATLAS_CHAT_RECOVERY_BUDGET_MICRO_USD || 0);
  if (!Number.isSafeInteger(maxCostMicroUsd) || maxCostMicroUsd < 0) throw new Error("budget");
  const raw = JSON.parse(environment.ATLAS_CHAT_TARGETS || "[]");
  if (!Array.isArray(raw) || raw.length > 6) throw new Error("targets");
  const ids = new Set(["primary", "fallback"]);
  const targets = raw.map((entry) => {
    if (!entry || !/^[a-zA-Z0-9_-]{1,64}$/u.test(entry.id) || ids.has(entry.id)) throw new Error("id");
    ids.add(entry.id);
    if (typeof entry.baseUrl !== "string" || typeof entry.model !== "string" || !entry.model.trim() || entry.model.length > 200) throw new Error("endpoint");
    if (entry.apiKey !== undefined || (entry.apiKeyEnv !== undefined && !/^[A-Z][A-Z0-9_]{0,100}$/u.test(entry.apiKeyEnv))) throw new Error("key");
    const resolved = resolveChatModel({ ATLAS_CHAT_BASE_URL: entry.baseUrl, ATLAS_CHAT_MODEL: entry.model, ATLAS_MODEL_API_KEY: entry.apiKeyEnv ? environment[entry.apiKeyEnv] || "" : "", ATLAS_CHAT_FALLBACK_MODEL: "none" });
    if (!resolved.configured) throw new Error("endpoint");
    const local = LOOPBACK_HOSTS.includes(new URL(resolved.baseUrl).hostname);
    if (entry.local !== undefined && entry.local !== local) throw new Error("locality");
    if (typeof entry.provider !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/u.test(entry.provider)) throw new Error("provider");
    const capabilities = entry.capabilities ?? {};
    for (const key of ["toolCalls", "vision", "structuredOutput"]) if (capabilities[key] !== undefined && typeof capabilities[key] !== "boolean") throw new Error("capabilities");
    for (const key of ["contextTokens", "maxOutputTokens"]) if (capabilities[key] !== undefined && (!Number.isSafeInteger(capabilities[key]) || capabilities[key] < 1)) throw new Error("capabilities");
    if (entry.reliability !== undefined && (typeof entry.reliability !== "number" || !Number.isFinite(entry.reliability) || entry.reliability < 0 || entry.reliability > 1)) throw new Error("reliability");
    const cost = entry.cost ?? (local ? { inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 } : null);
    if (cost && [cost.inputMicroUsdPerMillion, cost.outputMicroUsdPerMillion].some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("cost");
    if (entry.rateLimitScope !== undefined && !["model", "provider"].includes(entry.rateLimitScope)) throw new Error("scope");
    if (entry.policyAllowed !== undefined && typeof entry.policyAllowed !== "boolean") throw new Error("permission");
    return { id: entry.id, provider: entry.provider, baseUrl: resolved.baseUrl, model: resolved.model, apiKey: resolved.apiKey,
      local, capabilities, cost, reliability: entry.reliability ?? null, policyAllowed: entry.policyAllowed === true,
      credentialAvailable: !entry.apiKeyEnv || Boolean(resolved.apiKey), rateLimitScope: entry.rateLimitScope ?? "model" };
  });
  const order = environment.ATLAS_CHAT_TARGET_ORDER ? JSON.parse(environment.ATLAS_CHAT_TARGET_ORDER) : null;
  const available = ["primary", ...(primary.fallbackModel ? ["fallback"] : []), ...targets.map((target) => target.id)];
  if (order && (!Array.isArray(order) || order.length !== available.length || new Set(order).size !== available.length || order.some((id) => !available.includes(id)))) throw new Error("order");
  return { targets, routingPolicy: policy, targetOrder: order, allowPaidRecovery: environment.ATLAS_CHAT_ALLOW_PAID_RECOVERY === "true", recoveryBudget: { maxCostMicroUsd, spentMicroUsd: 0 } };
}

/** The absolute chat-completions URL for a resolved endpoint. */
export function completionsUrl(baseUrl) {
  return new URL("chat/completions", baseUrl).toString();
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
