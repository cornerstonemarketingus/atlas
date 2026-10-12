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

  const validated = validateOpenAiCompatibleBaseUrl(value);
  if (!validated.ok) return validated;

  return { ok: true, endpoint: withChatCompletionsPath(validated.url) };
}

export type OpenAiCompatibleBaseUrlResolution =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly message: string };

/**
 * Validates an OpenAI-compatible base URL (the part ending in `/v1`) without
 * committing it to a specific path. `resolveCoderEndpoint` builds the
 * chat-completions URL on top of this; a models-listing health check (see
 * `provider-health-check.ts`) needs the same validation but a different
 * suffix, so the rules live here once rather than drifting between callers.
 */
export function validateOpenAiCompatibleBaseUrl(value: string): OpenAiCompatibleBaseUrlResolution {
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

  return { ok: true, url };
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

/**
 * The shape Atlas declares for a self-hosted model.
 *
 * This exists because the vendor profile is wrong for a server you run. The
 * Groq profile declares a 128,000-token window; Ollama serves 4,096 by
 * default. Point Atlas at Ollama with the vendor numbers and a 12,000-token
 * prompt is silently truncated to its last 4,096 — the model sees a fragment,
 * answers from it, and nothing anywhere reports a problem. A wrong answer
 * delivered confidently is the worst failure this agent can have, so the
 * window is stated explicitly rather than inherited.
 *
 * The same number is handed to the model server (as OLLAMA_CONTEXT_LENGTH),
 * so the two cannot drift apart.
 */
export interface SelfHostedLimits {
  readonly contextWindowTokens: number;
  readonly maxOutputTokensPerTurn: number;
}

/** Large enough for this agent's prompts, small enough for a 16 GB runner. */
export const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 16_384;
/** Generation is the slow part on a CPU, so the per-turn ceiling is modest. */
export const SELF_HOSTED_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

export type SelfHostedLimitsResolution =
  | { readonly ok: true; readonly limits: SelfHostedLimits }
  | { readonly ok: false; readonly message: string };

export function resolveSelfHostedLimits(
  contextWindow: string | undefined,
  maxOutputTokens: string | undefined,
): SelfHostedLimitsResolution {
  const context = positiveInteger(contextWindow, "--context-window", SELF_HOSTED_DEFAULT_CONTEXT_WINDOW);
  if (typeof context === "string") return { ok: false, message: context };
  const output = positiveInteger(maxOutputTokens, "--max-output-tokens", SELF_HOSTED_DEFAULT_MAX_OUTPUT_TOKENS);
  if (typeof output === "string") return { ok: false, message: output };

  // A ceiling that leaves no room for the prompt is not a ceiling, it is a
  // guaranteed truncation on the very first turn.
  if (output >= context) {
    return {
      ok: false,
      message: `--max-output-tokens (${output}) must be smaller than --context-window (${context}).`,
    };
  }
  return { ok: true, limits: { contextWindowTokens: context, maxOutputTokensPerTurn: output } };
}

function positiveInteger(raw: string | undefined, flag: string, fallback: number): number | string {
  const value = (raw ?? "").trim();
  if (value.length === 0) return fallback;
  if (!/^\d+$/u.test(value)) return `${flag} must be a positive integer.`;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_000_000) {
    return `${flag} must be a positive integer no greater than 2000000.`;
  }
  return parsed;
}
