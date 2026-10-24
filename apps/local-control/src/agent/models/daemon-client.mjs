/**
 * The one way the daemon builds a chat model client for an endpoint.
 *
 * With nothing configured the endpoint is the local Ollama
 * (OLLAMA_HOST / ATLAS_OLLAMA_URL, default 127.0.0.1:11434) on its native
 * API, so the context window the conversation was fitted to is sent as
 * num_ctx. Any other endpoint speaks the OpenAI-compatible protocol unless
 * ATLAS_MODEL_PROTOCOL says otherwise. Both clients enforce the same egress
 * policy (egress.mjs) and report remote requests through `onRemote`.
 */
import { createModelClient } from "../model-client.mjs";
import { resolveModelProtocol, resolveOllamaBaseUrl } from "./egress.mjs";
import { createOllamaChatClient, DEFAULT_OLLAMA_CONTEXT_WINDOW } from "./ollama-chat-client.mjs";

export function defaultModelEndpoint(env = process.env) {
  return env.ATLAS_MODEL_ENDPOINT?.trim() || `${resolveOllamaBaseUrl(env)}/v1`;
}

/** The window chat is fitted to and the native client asks for; one number for both. */
export function daemonContextWindow(env = process.env, protocol = "ollama") {
  const configured = Number.parseInt(String(env.ATLAS_MODEL_CONTEXT_WINDOW ?? ""), 10);
  if (Number.isSafeInteger(configured) && configured >= 1_024) return { contextWindow: configured, contextSource: "configured" };
  // An OpenAI-compatible server's window is whatever it was started with; the
  // previous assumption stays. Ollama is told the window, so it is configured.
  return protocol === "ollama" ? { contextWindow: DEFAULT_OLLAMA_CONTEXT_WINDOW, contextSource: "configured" } : { contextWindow: 32_768, contextSource: "inferred" };
}

export function createDaemonModelClient({ baseUrl = undefined, protocol = undefined, env = process.env, egress, onRemote = null, contextWindow = undefined, fetchImpl = fetch } = {}) {
  const endpoint = baseUrl || defaultModelEndpoint(env);
  const chosen = protocol ?? resolveModelProtocol(endpoint, env);
  if (chosen === "ollama") {
    return createOllamaChatClient({ baseUrl: endpoint, contextWindow: contextWindow ?? daemonContextWindow(env, "ollama").contextWindow, egress, onRemote, fetchImpl });
  }
  return createModelClient({ baseUrl: endpoint, egress, onRemote, fetchImpl });
}
