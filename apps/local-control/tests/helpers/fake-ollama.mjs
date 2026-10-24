import { createServer } from "node:http";

/**
 * A protocol-accurate stand-in for Ollama at its real HTTP boundary.
 *
 * It answers the endpoints Atlas actually calls on a local Ollama:
 *
 *   GET  /api/version            { version }
 *   GET  /api/tags               installed models
 *   POST /api/show               model details (context length)
 *   POST /api/chat               native chat, with tools; stream false or NDJSON
 *   GET  /v1/models              Ollama's OpenAI-compatible model list
 *   POST /v1/chat/completions    OpenAI-compatible chat, with tools; JSON or SSE
 *
 * Every reply comes from `decide(request)`, a script the test supplies, so this
 * proves Atlas's wiring around a model, never a model's quality.
 *
 * `decide({ protocol, model, messages, tools, lastUser, toolResults, system })`
 * returns `{ content }` for a final answer, `{ toolCalls: [{ name, arguments }] }`
 * to call tools, optionally with `delayMs`. `mode` switches the whole server
 * to `"error500"` (every model call answers HTTP 500) for failure tests, and
 * `close()` / `listen()` take it down and bring it back on the same port.
 *
 * Every request is recorded in `requests`, including ones to paths it does
 * not serve, so a test can assert which calls reached the model.
 */
export const FAKE_OLLAMA_VERSION = "0.12.6";

export async function startFakeOllama({ decide, models = ["qwen2.5-coder:7b"], port = 0 } = {}) {
  const requests = [];
  const sockets = new Set();
  const state = { mode: "ok" };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake-ollama");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: raw.slice(0, 200) }; }
    const record = { method: request.method, path: url.pathname, host: request.headers.host ?? null, at: Date.now() };
    requests.push(record);
    const json = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };

    if (request.method === "GET" && url.pathname === "/api/version") return json(200, { version: FAKE_OLLAMA_VERSION });
    if (request.method === "GET" && url.pathname === "/api/tags") {
      return json(200, { models: models.map((name) => ({ name, model: name, modified_at: "2026-10-01T00:00:00Z", size: 4_700_000_000, digest: "0".repeat(64), details: { format: "gguf", family: "qwen2", parameter_size: "7.6B", quantization_level: "Q4_K_M" } })) });
    }
    if (request.method === "GET" && url.pathname === "/api/ps") return json(200, { models: [] });
    if (request.method === "POST" && url.pathname === "/api/show") {
      return json(200, { details: { family: "qwen2", parameter_size: "7.6B" }, model_info: { "general.architecture": "qwen2", "qwen2.context_length": 32768 }, capabilities: ["completion", "tools"] });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json(200, { object: "list", data: models.map((id) => ({ id, object: "model", created: 1_760_000_000, owned_by: "library" })) });
    }

    const native = request.method === "POST" && url.pathname === "/api/chat";
    const openai = request.method === "POST" && url.pathname === "/v1/chat/completions";
    if (!native && !openai) return json(404, { error: "404 page not found" });

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const text = (message) => (typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part) => part?.text ?? "").join("") : "");
    const tools = (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
    const users = messages.filter((m) => m.role === "user");
    Object.assign(record, {
      protocol: native ? "ollama" : "openai",
      model: body.model,
      stream: body.stream === true || (native && body.stream === undefined),
      tools,
      options: body.options ?? null,
      lastUser: text(users.at(-1)).slice(0, 2000),
    });
    if (state.mode === "error500") return json(500, { error: "llama runner process has terminated: exit status 2" });

    const decision = await decide({
      protocol: record.protocol,
      model: body.model,
      messages,
      tools,
      system: messages.filter((m) => m.role === "system").map(text).join("\n"),
      lastUser: text(users.at(-1)),
      allUser: users.map(text).join("\n\n"),
      toolResults: messages.filter((m) => m.role === "tool").map(text),
    });
    record.decision = decision.toolCalls ? { toolCalls: decision.toolCalls.map((call) => call.name) } : { content: String(decision.content ?? "").slice(0, 200) };
    if (decision.delayMs) await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
    if (response.destroyed) return;
    const calls = decision.toolCalls ?? [];
    const content = decision.content ?? "";

    if (native) {
      const message = { role: "assistant", content, ...(calls.length ? { tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.arguments ?? {} } })) } : {}) };
      const done = { model: body.model, created_at: new Date().toISOString(), done: true, done_reason: "stop", total_duration: 1_000_000, prompt_eval_count: 120, eval_count: 40 };
      if (body.stream === false) return json(200, { ...done, message });
      // Ollama streams NDJSON by default.
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(`${JSON.stringify({ model: body.model, created_at: done.created_at, message, done: false })}\n`);
      return response.end(`${JSON.stringify({ ...done, message: { role: "assistant", content: "" } })}\n`);
    }

    const wireCalls = calls.map((call, index) => ({ id: `call_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } }));
    const finish = wireCalls.length ? "tool_calls" : "stop";
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${requests.length}`;
    if (body.stream !== true) {
      return json(200, { id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: { role: "assistant", content, ...(wireCalls.length ? { tool_calls: wireCalls } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } });
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta, finishReason = null, usage = undefined) => response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`);
    frame({ role: "assistant", content: "" });
    // Split the answer in two so Atlas's delta handling is exercised.
    if (content) { const half = Math.ceil(content.length / 2); frame({ content: content.slice(0, half) }); if (content.length > half) frame({ content: content.slice(half) }); }
    wireCalls.forEach((call, index) => frame({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } }] }));
    frame({}, finish, { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
    response.end("data: [DONE]\n\n");
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });

  const listen = (onPort) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(onPort, "127.0.0.1", () => { server.off("error", reject); resolve(server.address().port); });
  });
  const boundPort = await listen(port);
  return {
    port: boundPort,
    origin: `http://127.0.0.1:${boundPort}`,
    requests,
    state,
    modelCalls: () => requests.filter((r) => r.protocol),
    /** Takes the server down: every later connection is refused. */
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
    listening: () => server.listening,
    /** Brings it back on the same port. */
    listen: () => listen(boundPort),
  };
}
