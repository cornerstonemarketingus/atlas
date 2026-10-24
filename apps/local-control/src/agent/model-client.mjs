/**
 * A streaming OpenAI-compatible chat client.
 *
 * "OpenAI-compatible" here means the wire format, not the vendor: Ollama,
 * llama.cpp, vLLM, LM Studio and text-generation-webui all speak it, which is
 * why Atlas can run with no hosted provider at all. Nothing in this file
 * names a vendor, and the credential — when there is one — never leaves the
 * Authorization header.
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

export class ModelRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModelRequestError";
    this.code = code;
  }
}

/** Loopback may be plain HTTP; anything else must be encrypted. */
export function assertReachableEndpoint(baseUrl) {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new ModelRequestError("INSECURE_ENDPOINT", "A model endpoint must use HTTPS unless it is loopback.");
  }
  return url;
}

export function createModelClient({ baseUrl = DEFAULT_BASE_URL, apiKey = null, fetchImpl = fetch } = {}) {
  const endpoint = assertReachableEndpoint(baseUrl);

  return {
    endpoint: endpoint.origin,

    /**
     * Yields normalized deltas as they arrive. Reasoning deltas are yielded
     * separately from text so the caller can summarize them rather than
     * forward them: raw chain-of-thought must never reach a client.
     */
    async *stream({ model, messages, tools = [], maxOutputTokens = 2048, temperature = 0, signal }) {
      const url = new URL("chat/completions", endpoint);
      const body = {
        model,
        messages,
        stream: true,
        temperature,
        max_tokens: maxOutputTokens,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      };
      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        // A cancelled request is the operator's decision; anything else here
        // means nothing answered, and "fetch failed" is not something an
        // operator can act on.
        if (signal?.aborted) throw error;
        throw new ModelRequestError(
          "MODEL_UNREACHABLE",
          `No model server answered at ${endpoint.origin}. Start Ollama (or another OpenAI-compatible server) there, or point ATLAS_MODEL_ENDPOINT somewhere else.`,
        );
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // Authentication and malformed-input failures are terminal: a caller
        // must not fall through to another route on either.
        const code = response.status === 401 || response.status === 403
          ? "MODEL_NOT_AUTHORIZED"
          : response.status === 400 || response.status === 422
            ? "MODEL_INVALID_INPUT"
            : "MODEL_REQUEST_FAILED";
        // A 5xx means a server answered but could not run the model (Ollama
        // reports a crashed or out-of-memory runner this way): say what to check.
        const hint = response.status >= 500
          ? ` The model server at ${endpoint.origin} is running but could not answer with '${model}'. Check that the model is installed and fits in memory (Ollama: \`ollama ps\`, \`ollama pull ${model}\`, and the \`ollama serve\` log), then retry.`
          : "";
        throw new ModelRequestError(code, `The model endpoint returned HTTP ${response.status}. ${summarize(detail)}${hint}`);
      }
      if (!response.body) throw new ModelRequestError("MODEL_REQUEST_FAILED", "The model endpoint returned no body.");

      const calls = new Map();
      let finishReason = null;
      let usage = null;
      let completed = false;
      let hasText = false;

      for await (const payload of readServerSentJson(response.body, signal)) {
        if (payload === STREAM_DONE) { completed = true; break; }
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.error) {
          throw new ModelRequestError("MODEL_INVALID_RESPONSE", "The model server returned an invalid stream event. Check the endpoint and retry the saved task.");
        }
        const choice = payload.choices?.[0];
        if (payload.usage) usage = payload.usage;
        if (!choice) continue;
        const delta = choice.delta ?? {};

        // Different servers name the reasoning field differently; all of them
        // are private and none of them are forwarded verbatim.
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? null;
        if (typeof reasoning === "string" && reasoning.length > 0) yield { type: "reasoning", delta: reasoning };
        if (typeof delta.content === "string" && delta.content.length > 0) {
          if (delta.content.trim()) hasText = true;
          yield { type: "text", delta: delta.content };
        }

        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          const current = calls.get(index) ?? { id: call.id ?? `call_${index}`, name: "", arguments: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          calls.set(index, current);
        }
        if (choice.finish_reason) { finishReason = choice.finish_reason; completed = true; }
      }

      // EOF alone is not a receipt. In particular, never release a partially
      // received tool call to the executor after a dropped connection.
      if (!completed) throw new ModelRequestError("MODEL_STREAM_INTERRUPTED", "The model stream ended before confirming completion. The response is incomplete; retry from the saved task state.");
      if (!hasText && calls.size === 0) throw new ModelRequestError("MODEL_EMPTY_RESPONSE", "The model returned no answer or tool call. Check the model and output budget, then retry the saved task.");
      for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
        if (!call.name.trim()) throw new ModelRequestError("MODEL_INVALID_RESPONSE", "The model returned an unnamed tool call. No tool was executed.");
        yield { type: "tool_call", id: call.id, name: call.name, arguments: call.arguments };
      }
      yield { type: "done", finishReason: finishReason ?? "stop", usage };
    },
  };
}

const STREAM_DONE = Symbol("stream-done");
const MAX_EVENT_CHARACTERS = 1_048_576;

/** Parses complete SSE events, retaining split CRLF and UTF-8 sequences. */
async function* readServerSentJson(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new ModelRequestError("MODEL_CANCELLED", "The model request was cancelled.");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/u.exec(buffer))) {
        if (boundary.index > MAX_EVENT_CHARACTERS) throw invalidEvent();
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r\n|\r|\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
        if (!data.trim()) continue;
        if (data.trim() === "[DONE]") { yield STREAM_DONE; return; }
        let payload;
        try { payload = JSON.parse(data); } catch { throw invalidEvent(); }
        yield payload;
      }
      if (buffer.length > MAX_EVENT_CHARACTERS) throw invalidEvent();
    }
    if (buffer.trim()) throw new ModelRequestError("MODEL_STREAM_INTERRUPTED", "The model stream ended inside an event. The response is incomplete; retry from the saved task state.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function invalidEvent() {
  return new ModelRequestError("MODEL_INVALID_RESPONSE", "The model server returned a malformed or oversized stream event. Check the endpoint and retry the saved task.");
}

function summarize(detail) {
  const trimmed = String(detail).replace(/\s+/gu, " ").trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
