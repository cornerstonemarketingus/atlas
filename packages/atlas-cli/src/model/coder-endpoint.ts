/**
 * Resolves a self-hosted, OpenAI-compatible endpoint for the coder agent.
 *
 * Atlas's Groq client is an ordinary OpenAI chat-completions client with a
 * vendor default baked in, so pointing it at vLLM, Ollama, llama.cpp's server,
 * TGI, LM Studio, or a rented GPU is a matter of changing one URL rather than
 * writing a provider. This is the validation for that URL.
 *
 * Pure on purpose: it decides where a customer's repository content gets sent,
 * and that is not a decision whose first observation should be in production.
 */

export type CoderEndpointResolution =
  | { readonly ok: true; readonly endpoint: URL | undefined }
  | { readonly ok: false; readonly message: string };

const CHAT_COMPLETIONS_PATH = "chat/completions";

/**
 * Loopback is exempt from the HTTPS requirement because a request that never
 * leaves the machine has no network to be intercepted on, and requiring a
 * certificate for `localhost` would push people toward disabling TLS
 * verification — strictly worse than allowing plain HTTP here.
 */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname === "::1"
    || hostname.endsWith(".localhost");
}

export function resolveCoderEndpoint(raw: string | undefined): CoderEndpointResolution {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: true, endpoint: undefined };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: `Model endpoint is not a valid URL: ${value}` };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: `Model endpoint must be http or https, not '${url.protocol.replace(":", "")}'.` };
  }

  // Plain HTTP to a remote host would put the prompt — which carries the
  // customer's repository content — on the wire in clear text. The whole
  // redaction chain upstream of this is pointless if the transport leaks.
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return {
      ok: false,
      message: `Model endpoint must use https for a remote host (${url.hostname}); plain http is allowed only for loopback.`,
    };
  }

  // A URL carrying credentials ends up in error messages, audit traces and CI
  // logs. Keys belong in the API-key environment variable, which is redacted.
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, message: "Model endpoint must not embed credentials; use the API key environment variable instead." };
  }

  if (url.search.length > 0 || url.hash.length > 0) {
    return { ok: false, message: "Model endpoint must not carry a query string or fragment." };
  }

  return { ok: true, endpoint: withChatCompletionsPath(url) };
}

/**
 * Accepts the OpenAI *base* URL — the part ending in `/v1` that every
 * compatible server documents — and appends the chat-completions path, so a
 * value copied straight out of vLLM's or Ollama's README works unchanged. A
 * URL that already names the path is left alone.
 */
function withChatCompletionsPath(url: URL): URL {
  const resolved = new URL(url.href);
  const path = resolved.pathname.replace(/\/+$/u, "");
  if (path.endsWith(`/${CHAT_COMPLETIONS_PATH}`)) {
    resolved.pathname = path;
    return resolved;
  }
  resolved.pathname = `${path}/${CHAT_COMPLETIONS_PATH}`;
  return resolved;
}
