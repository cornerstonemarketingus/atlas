/**
 * A streaming client for Ollama's native chat API (POST /api/chat).
 *
 * It yields exactly what agent/model-client.mjs yields (reasoning, text,
 * tool_call, done), so the conversation loop, team planner, agents and
 * verifier cannot tell the two apart. It exists because Ollama's
 * OpenAI-compatible /v1 endpoint cannot be told a context window: the
 * server's default (a few thousand tokens) applies, and a longer prompt loses
 * its beginning without any error. The native API takes `options.num_ctx`
 * per request, so the window the conversation was fitted to is the window
 * the model actually gets.
 *
 * Wire format (https://github.com/ollama/ollama/blob/main/docs/api.md):
 * the request carries `messages`, `tools` (OpenAI function shape), `stream`,
 * `think` and `options`; a streamed reply is newline-delimited JSON objects,
 * each with `message.content`, optionally `message.thinking` and
 * `message.tool_calls` (`function.arguments` is an object), and a final
 * object with `done: true`, `done_reason`, `prompt_eval_count` and
 * `eval_count`. A failure mid-stream is an object with `error`.
 *
 * There is no request timeout on purpose: a CPU-only machine can take many
 * minutes to evaluate a long prompt before the first token. Cancellation is
 * the caller's signal.
 */
import { ModelRequestError } from "../model-client.mjs";
import { checkModelEgress, modelEgressPolicy } from "./egress.mjs";

const MAX_LINE_CHARACTERS = 1_048_576;
export const DEFAULT_OLLAMA_CONTEXT_WINDOW = 16_384;

export function createOllamaChatClient({ baseUrl, contextWindow = DEFAULT_OLLAMA_CONTEXT_WINDOW, fetchImpl = fetch, egress = undefined, onRemote = null } = {}) {
  const root = new URL(String(baseUrl ?? "http://127.0.0.1:11434").replace(/\/v1\/?$/u, "/").replace(/\/?$/u, "/"));
  if (root.protocol !== "https:" && root.protocol !== "http:") throw new ModelRequestError("INSECURE_ENDPOINT", "An Ollama endpoint must be http or https.");
  const chatUrl = new URL("api/chat", root);
  const numCtx = Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : DEFAULT_OLLAMA_CONTEXT_WINDOW;

  return {
    endpoint: root.origin,
    protocol: "ollama",
    contextWindow: numCtx,

    async *stream({ model, messages, tools = [], maxOutputTokens = 2048, temperature = 0, signal }) {
      const destination = checkModelEgress(chatUrl, egress ?? modelEgressPolicy());
      if (destination.remote) onRemote?.({ host: destination.host, variable: destination.variable, model, purpose: "chat" });
      if (destination.remote && root.protocol !== "https:") throw new ModelRequestError("INSECURE_ENDPOINT", "A model endpoint must use HTTPS unless it is loopback.");
      const body = buildOllamaChatRequest({ model, messages, tools, maxOutputTokens, temperature, numCtx });
      let response;
      try {
        response = await fetchImpl(chatUrl, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ModelRequestError("MODEL_UNREACHABLE", `No Ollama server answered at ${root.origin}. Start it (run "ollama serve", or Models → Start model server) and try again. Atlas does not switch to a hosted provider when the local model is down.`);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        let message = detail;
        try { message = JSON.parse(detail).error ?? detail; } catch { /* keep raw */ }
        if (response.status === 404) throw new ModelRequestError("MODEL_NOT_FOUND", `Ollama does not have the model '${model}'. Install it with: ollama pull ${model}`);
        throw new ModelRequestError(response.status === 400 ? "MODEL_INVALID_INPUT" : "MODEL_REQUEST_FAILED", `Ollama returned HTTP ${response.status}. ${summarize(message)}`);
      }
      if (!response.body) throw new ModelRequestError("MODEL_REQUEST_FAILED", "Ollama returned no body.");

      const calls = [];
      let hasText = false;
      let final = null;
      for await (const payload of readJsonLines(response.body, signal)) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ModelRequestError("MODEL_INVALID_RESPONSE", "Ollama returned an invalid stream line.");
        if (typeof payload.error === "string") throw new ModelRequestError("MODEL_REQUEST_FAILED", `Ollama reported an error: ${summarize(payload.error)}`);
        const message = payload.message ?? {};
        if (typeof message.thinking === "string" && message.thinking.length > 0) yield { type: "reasoning", delta: message.thinking };
        if (typeof message.content === "string" && message.content.length > 0) {
          if (message.content.trim()) hasText = true;
          yield { type: "text", delta: message.content };
        }
        for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          const fn = call?.function ?? {};
          const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
          calls.push({ id: typeof call.id === "string" && call.id ? call.id : `call_${calls.length}`, name: String(fn.name ?? ""), arguments: args });
        }
        if (payload.done === true) { final = payload; break; }
      }

      // EOF without `done` is not a receipt; never release a half-received tool call.
      if (!final) throw new ModelRequestError("MODEL_STREAM_INTERRUPTED", "The Ollama stream ended before it reported completion. The response is incomplete; retry from the saved task state.");
      if (!hasText && calls.length === 0) throw new ModelRequestError("MODEL_EMPTY_RESPONSE", "The model returned no answer or tool call. Check the model and output budget, then retry the saved task.");
      for (const call of calls) {
        if (!call.name.trim()) throw new ModelRequestError("MODEL_INVALID_RESPONSE", "The model returned an unnamed tool call. No tool was executed.");
        yield { type: "tool_call", ...call };
      }
      const usage = {
        ...(Number.isSafeInteger(final.prompt_eval_count) ? { prompt_tokens: final.prompt_eval_count } : {}),
        ...(Number.isSafeInteger(final.eval_count) ? { completion_tokens: final.eval_count } : {}),
      };
      const finishReason = calls.length > 0 ? "tool_calls" : final.done_reason === "length" ? "length" : "stop";
      yield { type: "done", finishReason, usage: Object.keys(usage).length ? usage : null };
    },
  };
}

/** The /api/chat body for an OpenAI-shaped conversation. Exported for tests. */
export function buildOllamaChatRequest({ model, messages, tools = [], maxOutputTokens = 2048, temperature = 0, numCtx = DEFAULT_OLLAMA_CONTEXT_WINDOW }) {
  const names = new Map();
  for (const message of messages ?? []) for (const call of message?.tool_calls ?? []) if (call?.id) names.set(call.id, call.function?.name);
  return {
    model,
    messages: (messages ?? []).map((message) => toOllamaMessage(message, names)),
    stream: true,
    // Qwen3 reasons before answering by default; on a small local model that
    // spends the whole reply budget on hidden thinking. Same rule as the coder CLI.
    ...(/^qwen3(?::|$)/iu.test(String(model)) ? { think: false } : {}),
    ...(tools.length > 0 ? { tools: tools.map((tool) => (tool?.type === "function" ? tool : { type: "function", function: tool })) } : {}),
    options: { num_ctx: numCtx, num_predict: maxOutputTokens, temperature },
  };
}

function toOllamaMessage(message, names) {
  const { text, images } = splitContent(message.content);
  if (message.role === "tool") {
    const name = names.get(message.tool_call_id);
    return { role: "tool", content: text, ...(name ? { tool_name: name } : {}) };
  }
  const out = { role: message.role, content: text };
  if (images.length) out.images = images;
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    out.tool_calls = message.tool_calls.map((call) => ({ function: { name: call.function?.name, arguments: parseArguments(call.function?.arguments) } }));
  }
  return out;
}

function splitContent(content) {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: content == null ? "" : String(content), images: [] };
  const texts = [];
  const images = [];
  for (const part of content) {
    if (part?.type === "text") texts.push(String(part.text ?? ""));
    else if (part?.type === "image_url") {
      const match = /^data:[^;,]+;base64,(.*)$/su.exec(String(part.image_url?.url ?? ""));
      if (match) images.push(match[1]);
    }
  }
  return { text: texts.join("\n"), images };
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}

async function* readJsonLines(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new ModelRequestError("MODEL_CANCELLED", "The model request was cancelled.");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (line.length > MAX_LINE_CHARACTERS) throw invalidLine();
        let parsed;
        try { parsed = JSON.parse(line); } catch { throw invalidLine(); }
        yield parsed;
      }
      if (buffer.length > MAX_LINE_CHARACTERS) throw invalidLine();
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      let parsed;
      try { parsed = JSON.parse(buffer.trim()); } catch { throw new ModelRequestError("MODEL_STREAM_INTERRUPTED", "The Ollama stream ended inside a line. The response is incomplete; retry from the saved task state."); }
      yield parsed;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function invalidLine() {
  return new ModelRequestError("MODEL_INVALID_RESPONSE", "Ollama returned a malformed or oversized stream line.");
}

function summarize(detail) {
  const trimmed = String(detail).replace(/\s+/gu, " ").trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
