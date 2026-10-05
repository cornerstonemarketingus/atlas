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
/** Hosted providers answer within a minute; anything else is a model the owner runs, which may take longer. */
const HOSTED_ORIGINS = new Set(["https://api.groq.com", "https://api.openai.com"]);
const SELF_HOSTED_TIMEOUT_MS = 300_000;

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

/** Model names as a provider writes them (e.g. "openai/gpt-oss-120b", "qwen3:32b"); nothing that could smuggle a separator. */
const MODEL_NAME = /^[\w.:/@+-]{1,128}$/u;
export const MAX_POOL_MODELS = 8;

/**
 * Every model chat may use on this endpoint, in preference order: the main
 * model, then ATLAS_CHAT_MODELS (comma- or space-separated), then the
 * fallback. With the quota ledger bound, a call goes to the first of these
 * that has capacity right now, so one exhausted model does not make a person
 * wait while another has room. Names that do not look like model names are
 * dropped rather than sent.
 */
function modelPoolFor(environment, model, fallback) {
  const extra = (environment.ATLAS_CHAT_MODELS || "").split(/[\s,]+/u).filter((name) => MODEL_NAME.test(name));
  return [...new Set([model, ...extra, ...(fallback ? [fallback] : [])])].slice(0, MAX_POOL_MODELS);
}

/**
 * What kind of provider an endpoint is, for the owner to see which one served
 * a reply: never the address (a self-hosted one names the owner's machine).
 */
export function providerKind(baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return "unknown"; }
  return origin === "https://api.groq.com" ? "groq" : origin === "https://api.openai.com" ? "openai" : "self-hosted";
}

/** @returns {{ configured: boolean, reason?: string, baseUrl?: string, model?: string, apiKey?: string|null, fallbackModel?: string|null, models?: string[] }} */
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
  const fallbackModel = fallbackModelFor(environment, url, model);
  return { configured: true, baseUrl: url.toString(), model, apiKey: apiKey || null, fallbackModel, models: modelPoolFor(environment, model, fallbackModel), ...(HOSTED_ORIGINS.has(url.origin) ? {} : { timeoutMs: SELF_HOSTED_TIMEOUT_MS }) };
}

/**
 * What the live Worker's chat configuration amounts to, as flags only: no
 * endpoint, model name or key ever leaves the Worker through setup status.
 * The fallback is reported because production ran without one for weeks —
 * the runtime read ATLAS_CHAT_FALLBACK_MODEL but the deploy never uploaded
 * it, and nothing showed the gap.
 */
export function chatReadiness(environment = process.env) {
  const resolved = resolveChatModel(environment);
  const searchKey = (environment.ATLAS_TAVILY_API_KEY || environment.TAVILY_API_KEY || "").trim();
  return {
    configured: resolved.configured,
    ...(resolved.configured ? {} : { reason: resolved.reason }),
    fallbackModelConfigured: Boolean(resolved.fallbackModel),
    modelPoolSize: resolved.configured ? resolved.models.length : 0,
    webSearchConfigured: Boolean(searchKey),
  };
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
