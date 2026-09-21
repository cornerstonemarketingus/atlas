/**
 * Where a chat turn is sent, and whether it may be sent at all.
 *
 * Atlas talks to an OpenAI-compatible chat-completions server — Ollama,
 * vLLM, llama.cpp, LM Studio, or a hosted provider. Nothing here names a
 * vendor; the deployment picks one. The rules mirror the coder runtime's
 * (see LOCAL-MODEL.md) so an operator configures one endpoint, not two:
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
  const baseUrl = (environment.ATLAS_CHAT_BASE_URL || environment.ATLAS_CODER_BASE_URL || "").trim();
  const model = (environment.ATLAS_CHAT_MODEL || environment.ATLAS_CODER_MODEL || "").trim();
  const apiKey = (environment.ATLAS_MODEL_API_KEY || environment.GROQ_API_KEY || "").trim();

  if (!baseUrl || !model) {
    return {
      configured: false,
      reason: "Chat needs a model endpoint. Set ATLAS_CHAT_BASE_URL and ATLAS_CHAT_MODEL (or the ATLAS_CODER_* pair) to any OpenAI-compatible server — see Connections.",
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
  if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
    return { configured: false, reason: "A model endpoint must use HTTPS unless it is loopback." };
  }

  return { configured: true, baseUrl: url.toString(), model, apiKey: apiKey || null };
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
