import { classifyHttpFailure, classifyThrown } from "./errors.mjs";

/**
 * The generic adapter for any OpenAI-compatible server: Groq, OpenAI,
 * vLLM, llama.cpp's server, LM Studio, Ollama's /v1, a user's own GPU box.
 * Provider-specific behaviour overrides this, never replaces it
 * (docs/PROGRAM.md Phase 1.3; vendor SDKs are not used anywhere).
 *
 * The URL is built from a validated base: HTTPS for remote hosts, plain
 * HTTP only for loopback, no credentials, query or fragment in the URL.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function validateBaseUrl(baseUrl) {
  let url;
  try { url = new URL(String(baseUrl).endsWith("/") ? baseUrl : `${baseUrl}/`); } catch { throw new TypeError("The model endpoint is not a valid URL."); }
  if (url.username || url.password) throw new TypeError("The model endpoint must not carry credentials in its URL.");
  if (url.search || url.hash) throw new TypeError("The model endpoint must not contain a query or fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new TypeError("A model endpoint must use HTTPS unless it is loopback.");
  return url;
}

function headers(apiKey) {
  return { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

/**
 * The models the server says it serves, with the capabilities it reports.
 * Never throws: an unreachable server or a refusal comes back classified.
 * @returns {Promise<{ ok: true, models: { id: string, contextWindowTokens: number|null, ownedBy: string|null, active: boolean }[] } | { ok: false, kind: string, status: number|null }>}
 */
export async function listModels({ baseUrl, apiKey, fetcher = fetch, timeoutMs = 8_000 }) {
  const url = new URL("models", validateBaseUrl(baseUrl));
  let response;
  try {
    response = await fetcher(url, { headers: headers(apiKey), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, ...classifyThrown(error) };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const { kind, status } = classifyHttpFailure({ status: response.status, body, headers: response.headers });
    return { ok: false, kind, status };
  }
  let payload;
  try { payload = await response.json(); } catch { return { ok: false, kind: "INVALID_RESPONSE", status: response.status }; }
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models = rows
    .map((row) => ({
      id: typeof row?.id === "string" ? row.id : typeof row?.name === "string" ? row.name : "",
      // Groq reports context_window; others max_model_len (vLLM) or nothing.
      contextWindowTokens: Number.isFinite(row?.context_window) ? row.context_window : Number.isFinite(row?.max_model_len) ? row.max_model_len : null,
      ownedBy: typeof row?.owned_by === "string" ? row.owned_by : null,
      active: row?.active !== false,
    }))
    .filter((model) => model.id);
  return { ok: true, models };
}
