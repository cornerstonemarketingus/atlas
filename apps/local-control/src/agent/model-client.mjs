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
        throw new ModelRequestError(code, `The model endpoint returned HTTP ${response.status}. ${summarize(detail)}`);
      }
      if (!response.body) throw new ModelRequestError("MODEL_REQUEST_FAILED", "The model endpoint returned no body.");

      const calls = new Map();
      let finishReason = "stop";
      let usage = null;

      for await (const payload of readServerSentJson(response.body, signal)) {
        const choice = payload.choices?.[0];
        if (payload.usage) usage = payload.usage;
        if (!choice) continue;
        const delta = choice.delta ?? {};

        // Different servers name the reasoning field differently; all of them
        // are private and none of them are forwarded verbatim.
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? null;
        if (typeof reasoning === "string" && reasoning.length > 0) yield { type: "reasoning", delta: reasoning };
        if (typeof delta.content === "string" && delta.content.length > 0) yield { type: "text", delta: delta.content };

        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          const current = calls.get(index) ?? { id: call.id ?? `call_${index}`, name: "", arguments: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          calls.set(index, current);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
        yield { type: "tool_call", id: call.id, name: call.name, arguments: call.arguments };
      }
      yield { type: "done", finishReason, usage };
    },
  };
}

/** Parses an SSE body into the JSON payloads of its `data:` lines. */
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
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        for (const rawLine of frame.split("\n")) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]" || data.length === 0) continue;
          try {
            yield JSON.parse(data);
          } catch {
            // A truncated frame is not fatal; the stream carries on.
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function summarize(detail) {
  const trimmed = String(detail).replace(/\s+/gu, " ").trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
