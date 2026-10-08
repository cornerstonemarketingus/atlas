/**
 * Cloudflare Workers AI through the Worker's own `AI` binding.
 *
 * Cloudflare authenticates the binding as the account that runs the Worker,
 * so there is no API token to store, rotate, scope or leak, and it cannot
 * point at the wrong account. This adapter makes the binding look like an
 * OpenAI-compatible chat completions server to the rest of chat: it takes
 * the request body chat would POST, calls `ai.run(model, inputs)`, and
 * answers with an OpenAI-format Response (JSON, or server-sent events when
 * streaming was asked for). Workers AI answers either in OpenAI form
 * (`choices`) or in its own (`response` + `tool_calls`); both are accepted.
 */

/** The address chat sees for the binding; nothing is ever fetched from it. */
export const BINDING_BASE_URL = "https://workers-ai.binding/v1/";
export const BINDING_DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const BINDING_TIMEOUT_MS = 60_000;

function aborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The request was cancelled.", "AbortError");
}

/** Stop waiting at the caller's deadline, even if a binding ignores cancellation. */
function withAbort(promise, signal, onLate = () => {}) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = () => { settled = true; reject(signal.reason ?? new DOMException("The request was cancelled.", "AbortError")); };
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener("abort", cancel);
      if (settled) { onLate(value); return; }
      settled = true;
      resolve(value);
    }, (error) => { signal.removeEventListener("abort", cancel); if (!settled) { settled = true; reject(error); } });
  });
}

function toolCallsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((call, index) => {
    const fn = call?.function ?? call;
    const args = fn?.arguments ?? call?.arguments ?? {};
    return {
      id: typeof call?.id === "string" && call.id ? call.id : `call_${index}`,
      type: "function",
      function: { name: String(fn?.name ?? ""), arguments: typeof args === "string" ? args : JSON.stringify(args) },
    };
  }).filter((call) => call.function.name);
}

/** One Workers AI result as an OpenAI chat completion. */
export function toChatCompletion(result, model) {
  if (Array.isArray(result?.choices)) return { model, ...result };
  const text = typeof result?.response === "string" ? result.response : result?.response === undefined || result?.response === null ? "" : JSON.stringify(result.response);
  const calls = toolCallsOf(result?.tool_calls);
  const usage = result?.usage && typeof result.usage === "object" ? result.usage : undefined;
  return {
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }],
    ...(usage ? { usage } : {}),
  };
}

/** The completion as server-sent events, for a caller that asked to stream. */
function asEventStream(completion) {
  const choice = completion.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const chunks = [];
  if (message.content) chunks.push({ choices: [{ index: 0, delta: { role: "assistant", content: message.content } }] });
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    chunks.push({ choices: [{ index: 0, delta: { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } }] });
  }
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }], ...(completion.usage ? { usage: completion.usage } : {}) });
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Normalize native SSE incrementally; preserve OpenAI tool-call fragments. */
function nativeEventStream(upstream, signal) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let ended = false;
  let finish = false;
  let calledTools = false;
  let controller;
  const cancel = () => {
    void reader.cancel().catch(() => {});
    if (!ended) { ended = true; controller?.error(signal.reason ?? new DOMException("The request was cancelled.", "AbortError")); }
  };
  const done = () => {
    if (ended) return "";
    ended = true;
    signal.removeEventListener("abort", cancel);
    const terminal = finish ? "" : `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calledTools ? "tool_calls" : "stop" }] })}\n\n`;
    return `${terminal}data: [DONE]\n\n`;
  };
  function frame(value) {
    const data = value.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return "";
    if (data.trim() === "[DONE]") return done();
    let result;
    try { result = JSON.parse(data); } catch { throw new Error("Workers AI returned an invalid stream."); }
    if (result?.error) throw new Error("Workers AI refused the streaming request.");
    if (Array.isArray(result?.choices)) {
      if (result.choices.some((choice) => choice.finish_reason)) finish = true;
      return `data: ${JSON.stringify(result)}\n\n`;
    }
    const delta = {};
    if (typeof result?.response === "string") delta.content = result.response;
    const calls = toolCallsOf(result?.tool_calls);
    if (calls.length) { calledTools = true; delta.tool_calls = calls.map((call, index) => ({ index, ...call })); }
    return `data: ${JSON.stringify({ choices: [{ index: 0, delta }], ...(result?.usage ? { usage: result.usage } : {}) })}\n\n`;
  }
  return new ReadableStream({
    start(value) { controller = value; signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel(); },
    async pull(value) {
      try {
        while (!ended) {
          const next = await withAbort(reader.read(), signal);
          pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
          pending = pending.replace(/\r\n/gu, "\n");
          if (pending.length > 256 * 1024) throw new Error("Workers AI returned an oversized stream frame.");
          let output = "";
          let boundary;
          while (!ended && (boundary = pending.indexOf("\n\n")) >= 0) {
            output += frame(pending.slice(0, boundary));
            pending = pending.slice(boundary + 2);
          }
          if (next.done && !ended) { if (pending.trim()) output += frame(pending); output += done(); }
          if (output) value.enqueue(encoder.encode(output));
          if (ended) { void reader.cancel().catch(() => {}); value.close(); }
          if (output || ended) return;
        }
      } catch {
        ended = true;
        signal.removeEventListener("abort", cancel);
        void reader.cancel().catch(() => {});
        value.error(signal.aborted ? signal.reason : new Error("Workers AI streaming request failed."));
      }
    },
    cancel() { ended = true; signal.removeEventListener("abort", cancel); return reader.cancel().catch(() => {}); },
  });
}

/** A refusal as the status a provider would have answered, so routing and waiting work as for any provider. */
function statusOf(error) {
  const text = String(error?.message ?? error ?? "");
  if (/\b429\b|rate.?limit|too many requests|capacity|neurons/iu.test(text)) return 429;
  if (/\b40[13]\b|unauthori|forbidden|not entitled|permission/iu.test(text)) return 403;
  if (/\b404\b|no such model|model not found|unknown model/iu.test(text)) return 404;
  if (/\b400\b|invalid input|bad input|schema|validation/iu.test(text)) return 400;
  return 502;
}

/**
 * A fetch-shaped transport for chat's model calls, backed by the binding.
 * Errors are answered with a status and a fixed message, never the binding's
 * own text (which can echo the request).
 */
export function workersAIBindingTransport(ai, { timeoutMs = BINDING_TIMEOUT_MS } = {}) {
  return async function transport(_url, init) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    aborted(signal);
    let body;
    try { body = JSON.parse(init?.body ?? "{}"); } catch { return Response.json({ error: { message: "Invalid request body." } }, { status: 400 }); }
    // Native Workers AI documents automatic calls but no forced-choice
    // contract. Refuse that request rather than pretend forwarding enforces it.
    if (body.tool_choice !== undefined && !["auto", "none"].includes(body.tool_choice)) {
      return Response.json({ error: { code: "UNSUPPORTED_TOOL_CHOICE", message: "The Workers AI binding does not support forced tool choice." } }, { status: 400 });
    }
    const tools = [];
    if (body.tool_choice !== "none" && Array.isArray(body.tools)) for (const entry of body.tools) {
      const fn = entry?.function ?? entry;
      if (typeof fn?.name !== "string" || !fn.name.trim() || !fn.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters)) {
        return Response.json({ error: { message: "Invalid tool schema." } }, { status: 400 });
      }
      tools.push({ name: fn.name, ...(typeof fn.description === "string" ? { description: fn.description } : {}), parameters: fn.parameters });
    }
    const messages = (Array.isArray(body.messages) ? body.messages : []).map((message) => ({ ...message, content: message.content ?? "" }));
    const inputs = {
      messages,
      ...(tools.length ? { tools } : {}),
      ...(Number.isFinite(body.max_tokens) ? { max_tokens: body.max_tokens } : {}),
      ...(Number.isFinite(body.temperature) ? { temperature: body.temperature } : {}),
      ...(body.stream ? { stream: true } : {}),
    };
    let result;
    try {
      // Passing the signal also supports fetch-backed binding implementations.
      // The race bounds Atlas even when a native binding cannot cancel run().
      result = await withAbort(Promise.resolve().then(() => { aborted(signal); return ai.run(body.model, inputs, { signal }); }), signal,
        (late) => { if (typeof late?.cancel === "function") void late.cancel().catch(() => {}); });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const status = statusOf(error);
      return Response.json({ error: { code: "WORKERS_AI_BINDING", message: `Workers AI refused the request (${status}).` } }, { status });
    }
    aborted(signal);
    if (body.stream && typeof result?.getReader === "function") return new Response(nativeEventStream(result, signal), { headers: { "content-type": "text/event-stream" } });
    const completion = toChatCompletion(result, body.model);
    return body.stream ? asEventStream(completion) : Response.json(completion);
  };
}

/** Chat's endpoint for the binding, when the Worker has one. */
export function workersAIBindingModel(bindings = {}, environment = process.env) {
  const ai = bindings?.ai;
  if (!ai || typeof ai.run !== "function") return null;
  const model = (environment.ATLAS_WORKERS_AI_MODEL || "").trim() || BINDING_DEFAULT_MODEL;
  return {
    configured: true, reason: undefined, provider: "workers-ai", baseUrl: BINDING_BASE_URL, model, apiKey: null, fallbackModel: null,
    transport: workersAIBindingTransport(ai), capabilities: { tools: true, streaming: true, ...(model === BINDING_DEFAULT_MODEL ? { contextTokens: 24_000 } : {}) },
  };
}

/** Whether the binding serves a real inference, as categories only. */
export async function workersAIBindingHealth(bindings = {}, environment = process.env) {
  const endpoint = workersAIBindingModel(bindings, environment);
  if (!endpoint) return { provider: "workers-ai-binding", binding: "missing", category: "BINDING_MISSING" };
  let response;
  try {
    response = await endpoint.transport(BINDING_BASE_URL, {
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ model: endpoint.model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 16 }),
    });
  } catch {
    return { provider: "workers-ai-binding", binding: "present", model: endpoint.model, http: { inference: 504 }, inference: "failed", category: "PROVIDER_TIMEOUT" };
  }
  let answered = false;
  if (response.ok) {
    try {
      const choices = (await response.json())?.choices;
      answered = Array.isArray(choices) && choices.some((choice) => {
        const message = choice?.message;
        if (typeof message?.content === "string" && message.content.trim()) return true;
        return Array.isArray(message?.tool_calls) && message.tool_calls.some((call) => {
          if (typeof call?.function?.name !== "string" || !call.function.name.trim()) return false;
          try { const args = JSON.parse(call.function.arguments); return args !== null && typeof args === "object" && !Array.isArray(args); } catch { return false; }
        });
      });
    } catch { /* not an answer */ }
  }
  const category = answered ? "OK" : response.status === 429 ? "PROVIDER_RATE_LIMIT" : response.status === 403 ? "INSUFFICIENT_PERMISSION" : response.status === 404 || response.status === 400 ? "MODEL_UNAVAILABLE" : "PROVIDER_UNAVAILABLE";
  return { provider: "workers-ai-binding", binding: "present", model: endpoint.model, http: { inference: response.status }, inference: answered ? "ok" : "failed", category };
}
