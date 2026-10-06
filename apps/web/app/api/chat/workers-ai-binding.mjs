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
export function workersAIBindingTransport(ai) {
  return async function transport(_url, init) {
    let body;
    try { body = JSON.parse(init?.body ?? "{}"); } catch { return Response.json({ error: { message: "Invalid request body." } }, { status: 400 }); }
    const messages = (Array.isArray(body.messages) ? body.messages : []).map((message) => ({ ...message, content: message.content ?? "" }));
    const inputs = {
      messages,
      ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
      ...(Number.isFinite(body.max_tokens) ? { max_tokens: body.max_tokens } : {}),
      ...(Number.isFinite(body.temperature) ? { temperature: body.temperature } : {}),
    };
    let result;
    try {
      result = await ai.run(body.model, inputs);
    } catch (error) {
      const status = statusOf(error);
      return Response.json({ error: { code: "WORKERS_AI_BINDING", message: `Workers AI refused the request (${status}).` } }, { status });
    }
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
    transport: workersAIBindingTransport(ai), capabilities: { tools: true, streaming: true },
  };
}

/** Whether the binding serves a real inference, as categories only. */
export async function workersAIBindingHealth(bindings = {}, environment = process.env) {
  const endpoint = workersAIBindingModel(bindings, environment);
  if (!endpoint) return { provider: "workers-ai-binding", binding: "missing", category: "BINDING_MISSING" };
  const response = await endpoint.transport(BINDING_BASE_URL, {
    body: JSON.stringify({ model: endpoint.model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 16 }),
  });
  let answered = false;
  if (response.ok) {
    try { answered = Array.isArray((await response.json())?.choices); } catch { /* not an answer */ }
  }
  const category = answered ? "OK" : response.status === 429 ? "PROVIDER_RATE_LIMIT" : response.status === 403 ? "INSUFFICIENT_PERMISSION" : response.status === 404 || response.status === 400 ? "MODEL_UNAVAILABLE" : "PROVIDER_UNAVAILABLE";
  return { provider: "workers-ai-binding", binding: "present", model: endpoint.model, http: { inference: response.status }, inference: answered ? "ok" : "failed", category };
}
