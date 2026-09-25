/**
 * Ollama native API adapter (/api/chat, /api/tags).
 *
 * The agent runtime talks to Ollama through its OpenAI-compatible endpoint
 * (agent/model-client.mjs). This adapter uses the native API instead because
 * it exposes what the capability registry needs: the installed model list
 * with sizes, `format: "json"` for structured output, and tool calls with
 * arguments as objects. The base URL must be loopback unless `allowRemote`
 * is set — a "local" model that is actually across the network would quietly
 * break the local_only privacy guarantee. Every request has a timeout.
 */
import { inferContextWindow } from "../../agent/models/discovery.mjs";
import { isLoopbackUrl } from "./capabilities.mjs";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export class OllamaError extends Error {
  constructor(code, message, status = undefined) {
    super(message);
    this.name = "OllamaError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export function createOllamaAdapter({ baseUrl = DEFAULT_OLLAMA_URL, timeoutMs = 30_000, fetchImpl = fetch, allowRemote = false } = {}) {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (!allowRemote && !isLoopbackUrl(base.href)) throw new OllamaError("NOT_LOOPBACK", `Ollama base URL ${base.origin} is not loopback; pass allowRemote to use it.`);
  if (!["http:", "https:"].includes(base.protocol)) throw new OllamaError("INVALID_URL", "Ollama base URL must be http(s).");

  async function request(path, { method = "GET", body, signal, timeout = timeoutMs } = {}) {
    const timer = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    let response;
    try {
      response = await fetchImpl(new URL(path, base), {
        method,
        signal: combined,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (timer.aborted) throw new OllamaError("TIMEOUT", `Ollama did not answer ${path} within ${timeout}ms.`);
      if (signal?.aborted) throw error;
      throw new OllamaError("UNREACHABLE", `No Ollama server answered at ${base.origin}.`);
    }
    let text;
    try { text = await response.text(); }
    catch { throw timer.aborted ? new OllamaError("TIMEOUT", `Ollama did not finish ${path} within ${timeout}ms.`) : new OllamaError("BAD_RESPONSE", "Ollama response body could not be read."); }
    if (!response.ok) {
      let message = text.slice(0, 500);
      try { message = JSON.parse(text).error ?? message; } catch { /* keep raw */ }
      throw new OllamaError(response.status === 404 ? "MODEL_NOT_FOUND" : "REQUEST_FAILED", `Ollama ${path} failed (${response.status}): ${message}`, response.status);
    }
    try { return JSON.parse(text); }
    catch { throw new OllamaError("BAD_RESPONSE", `Ollama ${path} returned invalid JSON.`); }
  }

  const adapter = {
    baseUrl: base.origin,

    async listModels({ signal } = {}) {
      const body = await request("api/tags", { signal });
      return (body.models ?? []).map((model) => ({
        name: model.name,
        sizeBytes: model.size ?? null,
        family: model.details?.family ?? null,
        parameterSize: model.details?.parameter_size ?? null,
        quantization: model.details?.quantization_level ?? null,
      }));
    },

    /**
     * @returns { text, toolCalls: [{ name, arguments }], usage: { inputTokens, outputTokens }, latencyMs, model }
     */
    async chat({ model, messages, tools = [], format, options, signal, timeout } = {}) {
      if (typeof model !== "string" || model === "") throw new OllamaError("INVALID_INPUT", "chat() needs a model name.");
      const body = {
        model,
        messages,
        stream: false,
        ...(tools.length ? { tools: tools.map((tool) => (tool.type === "function" ? tool : { type: "function", function: tool })) } : {}),
        ...(format ? { format } : {}),
        ...(options ? { options } : {}),
      };
      const response = await request("api/chat", { method: "POST", body, signal, timeout });
      const message = response.message ?? {};
      return {
        model: response.model ?? model,
        text: typeof message.content === "string" ? message.content : "",
        toolCalls: (message.tool_calls ?? []).map((call) => ({ name: call.function?.name, arguments: call.function?.arguments ?? {} })),
        usage: { inputTokens: response.prompt_eval_count ?? null, outputTokens: response.eval_count ?? null },
        latencyMs: typeof response.total_duration === "number" ? Math.round(response.total_duration / 1e6) : null,
        done: response.done !== false,
      };
    },

    /** Capability-suite interface. */
    complete(requestBody) {
      return adapter.chat(requestBody);
    },

    /** Declared (unmeasured) capability profiles for the installed models. */
    async profiles({ signal } = {}) {
      const models = await adapter.listModels({ signal });
      return models.map((model) => ({
        id: `ollama:${model.name}`,
        provider: "ollama",
        model: model.name,
        endpoint: base.origin,
        local: isLoopbackUrl(base.href),
        capabilities: { contextTokens: inferContextWindow(model.name).contextWindow, toolCalls: false, structuredOutput: false, vision: /llava|vision|vl\b/iu.test(model.name) },
        costPerMTokIn: 0,
        costPerMTokOut: 0,
      }));
    },
  };
  return adapter;
}
