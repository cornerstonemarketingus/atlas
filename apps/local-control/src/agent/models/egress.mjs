/**
 * Where the daemon may send a model request: the local-only guarantee.
 *
 * Atlas runs on a model server on this machine (Ollama on 127.0.0.1:11434 by
 * default). A model server anywhere else is used only when the owner named it
 * in one of the variables below; nothing in the daemon picks a hosted
 * provider on its own, and a provider API key that merely exists in the
 * environment (GROQ_API_KEY, OPENAI_API_KEY, ...) is never read here.
 *
 *   - No remote endpoint configured: local-only. Every model, transcription
 *     and vision request must go to a loopback address; anything else is
 *     refused with REMOTE_MODEL_REFUSED before a connection is opened.
 *   - A remote endpoint configured: exactly the origins the owner named are
 *     allowed, each logged at startup and audited per request. Others are
 *     still refused.
 *   - ATLAS_LOCAL_ONLY=1: local-only even when remote endpoints are
 *     configured; they are listed as refused instead of used.
 *
 * A route on this machine never fails over to a remote route unless the
 * owner also sets ATLAS_MODEL_REMOTE_FALLBACK=1 (routed-client.mjs): when the
 * local model is down the person gets a clear error, not a quiet switch.
 */
import { ModelRequestError } from "../model-client.mjs";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_PORT = "11434";

/** Variables that name a model endpoint. Setting one of them to a remote URL is the opt-in. */
export const MODEL_ENDPOINT_VARIABLES = Object.freeze([
  "ATLAS_MODEL_ENDPOINT",
  "ATLAS_MODEL_ROUTES",
  "ATLAS_OLLAMA_URL",
  "OLLAMA_HOST",
  "ATLAS_SPEECH_ENDPOINT",
  "ATLAS_GENESIS_BASE_URL",
  "ATLAS_GENESIS_VISION_BASE_URL",
  "ATLAS_SELF_IMPROVE_BASE_URL",
]);

export function isLoopbackHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

export function isLoopbackUrl(value) {
  try { return isLoopbackHost(new URL(value).hostname); } catch { return false; }
}

/**
 * The Ollama server this machine talks to: ATLAS_OLLAMA_URL, else OLLAMA_HOST
 * (the variable Ollama itself reads, which may be "host", "host:port" or a
 * URL; a wildcard bind address such as 0.0.0.0 means this machine), else
 * http://127.0.0.1:11434. Returns an origin with no trailing slash.
 */
export function resolveOllamaBaseUrl(env = process.env) {
  const explicit = env.ATLAS_OLLAMA_URL?.trim();
  if (explicit) return new URL(explicit).origin;
  const host = env.OLLAMA_HOST?.trim();
  if (!host) return DEFAULT_OLLAMA_URL;
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(host) ? host : `http://${host}`);
  if (["0.0.0.0", "[::]", "::"].includes(url.hostname)) url.hostname = "127.0.0.1";
  if (!url.port && url.protocol === "http:") url.port = OLLAMA_PORT;
  return url.origin;
}

/** Whether a base URL speaks Ollama's native API: ATLAS_MODEL_PROTOCOL wins, else the Ollama port on loopback. */
export function resolveModelProtocol(baseUrl, env = process.env) {
  const declared = env.ATLAS_MODEL_PROTOCOL?.trim().toLowerCase();
  if (declared === "ollama" || declared === "openai") return declared;
  try {
    const url = new URL(baseUrl);
    const ollama = new URL(resolveOllamaBaseUrl(env));
    return isLoopbackHost(url.hostname) && (url.port === OLLAMA_PORT || url.origin === ollama.origin) ? "ollama" : "openai";
  } catch {
    return "openai";
  }
}

function truthy(value) {
  return /^(?:1|true|yes|on)$/iu.test(String(value ?? "").trim());
}

function originsFrom(variable, value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  if (variable === "ATLAS_MODEL_ROUTES") {
    try {
      const routes = JSON.parse(text);
      return Array.isArray(routes) ? routes.map((route) => route?.endpoint).filter((endpoint) => typeof endpoint === "string") : [];
    } catch { return []; }
  }
  if (variable === "OLLAMA_HOST") {
    try { return [resolveOllamaBaseUrl({ OLLAMA_HOST: text })]; } catch { return []; }
  }
  return [text];
}

/**
 * The egress policy for this process, computed once from the environment.
 * `allowed` maps each remote origin the owner configured to the variable
 * that named it; `refused` lists the ones ATLAS_LOCAL_ONLY overrides.
 */
export function modelEgressPolicy(env = process.env) {
  const forced = truthy(env.ATLAS_LOCAL_ONLY);
  const configured = new Map();
  for (const variable of MODEL_ENDPOINT_VARIABLES) {
    for (const endpoint of originsFrom(variable, env[variable])) {
      let url;
      try { url = new URL(endpoint); } catch { continue; }
      if (isLoopbackHost(url.hostname) || configured.has(url.origin)) continue;
      configured.set(url.origin, variable);
    }
  }
  const allowed = forced ? new Map() : configured;
  return Object.freeze({
    localOnly: allowed.size === 0,
    forced,
    allowed,
    refused: forced ? [...configured.entries()].map(([origin, variable]) => ({ host: new URL(origin).host, variable })) : [],
    remoteFallback: !forced && truthy(env.ATLAS_MODEL_REMOTE_FALLBACK),
  });
}

/**
 * Checks one destination against the policy before anything is sent.
 * Returns `{ remote, host, variable }`; throws REMOTE_MODEL_REFUSED.
 */
export function checkModelEgress(target, policy, purpose = "model") {
  const url = target instanceof URL ? target : new URL(target);
  if (isLoopbackHost(url.hostname)) return { remote: false, host: url.host, variable: null };
  const variable = policy?.allowed?.get(url.origin) ?? null;
  if (variable) return { remote: true, host: url.host, variable };
  const why = policy?.forced
    ? "ATLAS_LOCAL_ONLY is on, so Atlas only uses model servers on this machine"
    : policy?.localOnly
      ? "Atlas is in local-only mode: no remote model endpoint is configured"
      : "that host is not one of the remote model endpoints configured for Atlas";
  throw new ModelRequestError(
    "REMOTE_MODEL_REFUSED",
    `Refused to send a ${purpose} request to ${url.host}: ${why}. Start a local model server (Ollama on ${DEFAULT_OLLAMA_URL}), or opt in to a remote provider by naming it in ATLAS_MODEL_ENDPOINT or ATLAS_MODEL_ROUTES (see SOVEREIGN-MODE.md).`,
  );
}

/** What health reports and the startup log say about model egress. No URL paths, no credentials. */
export function describeModelEgress(policy) {
  return {
    mode: policy.localOnly ? "local-only" : "remote-opt-in",
    forced: policy.forced,
    remote: [...policy.allowed.entries()].map(([origin, variable]) => ({ host: new URL(origin).host, variable })),
    refused: policy.refused,
    remoteFallback: policy.remoteFallback,
  };
}

export function egressSummary(policy) {
  const described = describeModelEgress(policy);
  if (described.mode === "local-only") {
    const refused = described.refused.length ? ` ATLAS_LOCAL_ONLY overrides the configured ${described.refused.map((entry) => `${entry.host} (${entry.variable})`).join(", ")}.` : "";
    return `Model egress: local-only. Model requests go only to servers on this machine; no hosted provider is used.${refused}`;
  }
  return `Model egress: remote model endpoints explicitly configured: ${described.remote.map((entry) => `${entry.host} (${entry.variable})`).join(", ")}. Every request to them is audited${described.remoteFallback ? "; local routes may fail over to them (ATLAS_MODEL_REMOTE_FALLBACK=1)" : "; a local route never fails over to them"}.`;
}
