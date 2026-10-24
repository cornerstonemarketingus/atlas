/**
 * A protocol-accurate fake Ollama server for tests. TEST INFRASTRUCTURE ONLY:
 * it proves Atlas speaks Ollama's wire protocol and keeps traffic on this
 * machine. It says nothing about how a real model behaves.
 *
 * It listens on 127.0.0.1 and implements, following
 * https://github.com/ollama/ollama/blob/main/docs/api.md and
 * https://github.com/ollama/ollama/blob/main/docs/openai.md:
 *
 *   GET  /api/version                 { version }
 *   GET  /api/tags                    { models: [{ name, model, modified_at, size, digest, details }] }
 *   POST /api/chat                    stream (default true): NDJSON chunks, then a final
 *                                     { done: true, done_reason, prompt_eval_count, eval_count, ... };
 *                                     stream:false: one object. tools → message.tool_calls with
 *                                     object arguments. Unknown model → 404 { error }.
 *   GET  /v1/models                   { object: "list", data: [{ id, object: "model", ... }] }
 *   POST /v1/chat/completions         OpenAI-compatible, streaming SSE or one JSON body,
 *                                     tool_calls with string arguments.
 *
 * `respond(request)` scripts the assistant: return { content, toolCalls, thinking }.
 * Without num_ctx the server applies `defaultContext` (Ollama's default is a
 * few thousand tokens) and reports at most that many prompt tokens, as the
 * real server does after truncating.
 */
import { createServer } from "node:http";

const DIGEST = "sha256:" + "0".repeat(64);

export async function startFakeOllama({ models = ["qwen2.5-coder:7b"], respond = defaultRespond, version = "0.12.6", defaultContext = 4_096 } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "invalid JSON" }); }
    }
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    requests.push({ method: req.method, path, body, headers: req.headers });

    if (req.method === "GET" && path === "/api/version") return json(res, 200, { version });
    if (req.method === "GET" && path === "/api/tags") {
      return json(res, 200, { models: models.map((name) => ({
        name, model: name, modified_at: "2026-10-01T00:00:00Z", size: 4_683_087_332, digest: DIGEST,
        details: { parent_model: "", format: "gguf", family: name.split(/[:.\d]/u)[0] || "llama", families: [name.split(/[:.\d]/u)[0] || "llama"], parameter_size: /:(\d+(?:\.\d+)?b)/iu.exec(name)?.[1]?.toUpperCase() ?? "7B", quantization_level: "Q4_K_M" },
      })) });
    }
    if (req.method === "GET" && path === "/v1/models") {
      return json(res, 200, { object: "list", data: models.map((id) => ({ id, object: "model", created: 1_760_000_000, owned_by: "library" })) });
    }
    if (req.method === "POST" && path === "/api/chat") {
      if (!body?.model) return json(res, 400, { error: "model is required" });
      if (!models.includes(body.model)) return json(res, 404, { error: `model "${body.model}" not found, try pulling it first` });
      const numCtx = body.options?.num_ctx ?? defaultContext;
      const promptTokens = Math.min(numCtx, Math.ceil(JSON.stringify(body.messages ?? []).length / 4));
      const reply = await respond({ protocol: "ollama", ...body });
      const toolCalls = (reply.toolCalls ?? []).map((call) => ({ function: { name: call.name, arguments: call.arguments ?? {} } }));
      const stats = { total_duration: 1_200_000_000, load_duration: 50_000_000, prompt_eval_count: promptTokens, prompt_eval_duration: 400_000_000, eval_count: 12, eval_duration: 700_000_000 };
      const created_at = new Date().toISOString();
      if (body.stream === false) {
        return json(res, 200, { model: body.model, created_at, message: { role: "assistant", content: reply.content ?? "", ...(reply.thinking ? { thinking: reply.thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, done_reason: "stop", done: true, ...stats });
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (value) => res.write(`${JSON.stringify(value)}\n`);
      if (reply.thinking) line({ model: body.model, created_at, message: { role: "assistant", content: "", thinking: reply.thinking }, done: false });
      for (const piece of chunks(reply.content ?? "")) line({ model: body.model, created_at, message: { role: "assistant", content: piece }, done: false });
      if (toolCalls.length) line({ model: body.model, created_at, message: { role: "assistant", content: "", tool_calls: toolCalls }, done: false });
      line({ model: body.model, created_at, message: { role: "assistant", content: "" }, done_reason: "stop", done: true, ...stats });
      return res.end();
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      if (!body?.model) return json(res, 400, { error: { message: "model is required", type: "invalid_request_error" } });
      if (!models.includes(body.model)) return json(res, 404, { error: { message: `model "${body.model}" not found, try pulling it first`, type: "api_error" } });
      const reply = await respond({ protocol: "openai", ...body });
      const toolCalls = (reply.toolCalls ?? []).map((call, index) => ({ index, id: `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } }));
      const usage = { prompt_tokens: Math.min(defaultContext, Math.ceil(JSON.stringify(body.messages ?? []).length / 4)), completion_tokens: 12, total_tokens: 0 };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      const finish = toolCalls.length ? "tool_calls" : "stop";
      if (!body.stream) {
        return json(res, 200, { id: "chatcmpl-1", object: "chat.completion", created: 1_760_000_000, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: reply.content ?? "", ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index, ...call }) => call) } : {}) }, finish_reason: finish }], usage });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1_760_000_000, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      for (const piece of chunks(reply.content ?? "")) event({ role: "assistant", content: piece });
      if (toolCalls.length) event({ tool_calls: toolCalls });
      event({}, finish);
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    return json(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    chats: () => requests.filter((request) => request.path === "/api/chat" || request.path === "/v1/chat/completions"),
    close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}

function defaultRespond(request) {
  const last = request.messages?.at(-1);
  return { content: `Local answer to: ${typeof last?.content === "string" ? last.content.slice(0, 80) : "(no text)"}` };
}

function chunks(text) {
  const out = [];
  for (let index = 0; index < text.length; index += 7) out.push(text.slice(index, index + 7));
  return out;
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
