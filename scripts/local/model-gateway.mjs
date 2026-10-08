import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The authenticated door between hosted Atlas and a model on your own machine
 * (Ollama, or any OpenAI-compatible local server).
 *
 * Only inference is exposed: GET /v1/models and POST /v1/chat/completions,
 * behind a 32+ character bearer token. Ollama's management API (pull, delete,
 * create, copy, push) is never reachable through it.
 *
 * It carries what Atlas's chat needs to use the model as its main model:
 * streaming, tool definitions and tool choice, and long conversations. A local
 * machine runs a few generations at a time, so requests beyond `concurrency`
 * wait in a short queue rather than being refused; a full queue, or a wait
 * that runs out, answers 429 with a retry-after, which hosted Atlas treats like
 * any provider's rate limit (it routes to its fallback, or waits).
 */

/** Request fields forwarded to the model server; anything else is dropped. */
const FORWARDED = ["model", "messages", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stop", "seed", "response_format", "reasoning_effort"];

async function boundedErrorText(result, limit = 8192) {
  const chunks = [];
  let size = 0;
  if (!result.body) return "";
  for await (const chunk of result.body) {
    const part = Buffer.from(chunk).subarray(0, limit - size);
    chunks.push(part);
    size += part.length;
    if (size >= limit) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createGateway({
  token,
  model = null,
  models = null,
  upstream = "http://127.0.0.1:11434",
  fetcher = fetch,
  concurrency = 1,
  queueLimit = 8,
  queueWaitMs = 120_000,
  maxBodyBytes = 4 * 1024 * 1024,
  maxMessages = 400,
  maxTokens = 8192,
  generationTimeoutMs = 600_000,
  healthTimeoutMs = 1500,
  defaultReasoningEffort = null,
  capacityCooldownMs = 60_000,
}) {
  const upstreamUrl = new URL(upstream);
  if (upstreamUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(upstreamUrl.hostname) || upstreamUrl.username || upstreamUrl.password || upstreamUrl.search || upstreamUrl.hash || upstreamUrl.pathname !== "/") throw new Error("Gateway upstream must be a bare loopback HTTP origin");
  const allowed = new Set(String(models ?? model ?? "").split(",").map((name) => name.trim()).filter(Boolean));
  if (!token || token.length < 32 || allowed.size === 0) throw new Error("A model and a 32+ character gateway token are required");
  if ([...allowed].some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,127}$/u.test(name))) throw new Error("Invalid gateway model name");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a whole number of at least 1");
  if (!Number.isInteger(capacityCooldownMs) || capacityCooldownMs < 1) throw new Error("capacityCooldownMs must be a positive whole number");
  const expected = Buffer.from(`Bearer ${token}`);
  let active = 0;
  let capacityUnavailableUntil = 0;
  const waiting = [];

  const release = () => {
    active -= 1;
    while (waiting.length && active < concurrency) {
      const next = waiting.shift();
      if (next.settled) continue;
      next.settled = true;
      clearTimeout(next.timer);
      active += 1;
      next.resolve(true);
    }
  };
  /** Resolves true with a generation slot, or false when the wait ran out or the caller left. */
  const acquire = (response) => {
    if (active < concurrency) { active += 1; return Promise.resolve(true); }
    if (waiting.filter((entry) => !entry.settled).length >= queueLimit) return Promise.resolve(false);
    return new Promise((resolve) => {
      const entry = { resolve, settled: false, timer: null };
      const give = () => { if (!entry.settled) { entry.settled = true; clearTimeout(entry.timer); const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); resolve(false); } };
      entry.timer = setTimeout(give, queueWaitMs);
      // The response, not the request: a request's "close" fires once its body is read.
      response.once("close", give);
      waiting.push(entry);
    });
  };

  return http.createServer(async (request, response) => {
    const reply = (status, message, headers = {}) => {
      if (response.headersSent) { response.end(); return; }
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      response.end(JSON.stringify({ error: { message } }));
    };
    const supplied = Buffer.from(request.headers.authorization || "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, "Authentication required");
    if (request.method === "GET" && request.url === "/v1/health") {
      if (Date.now() < capacityUnavailableUntil) return reply(503, "Local model is over capacity: insufficient memory.", { "retry-after": String(Math.ceil((capacityUnavailableUntil - Date.now()) / 1000)) });
      try {
        const result = await fetcher(`${upstreamUrl.origin}/v1/models`, { signal: AbortSignal.timeout(healthTimeoutMs), redirect: "error" });
        const data = await result.json();
        if (!result.ok || !data.data?.some((entry) => allowed.has(entry.id))) return reply(503, "Local model unavailable");
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return response.end(JSON.stringify({ online: true, provider: "local", models: [...allowed] }));
      } catch { return reply(503, "Local AI computer offline"); }
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return response.end(JSON.stringify({ object: "list", data: [...allowed].map((id) => ({ id, object: "model", owned_by: "local" })) }));
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return reply(404, "Not found");

    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) return reply(413, "Request too large");
        chunks.push(chunk);
      }
    } catch {
      // A client can disconnect midway through its upload. The async HTTP
      // handler must consume that rejection rather than terminate the gateway.
      if (response.destroyed) return;
      return reply(400, "Incomplete request body");
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(400, "Invalid JSON"); }
    if (!body || !allowed.has(body.model) || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > maxMessages) return reply(400, "Unsupported model or request");
    if (body.tools !== undefined && !Array.isArray(body.tools)) return reply(400, "tools must be a list");

    const forwarded = Object.fromEntries(FORWARDED.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
    for (const field of ["max_tokens", "max_completion_tokens"]) {
      if (forwarded[field] !== undefined) forwarded[field] = Math.min(maxTokens, Math.max(1, Math.floor(Number(forwarded[field]) || maxTokens)));
    }
    if (forwarded.max_tokens === undefined && forwarded.max_completion_tokens === undefined) forwarded.max_tokens = maxTokens;
    forwarded.stream = body.stream === true;
    if (forwarded.reasoning_effort === undefined && defaultReasoningEffort) forwarded.reasoning_effort = defaultReasoningEffort;

    if (!(await acquire(response))) {
      if (response.destroyed) return undefined;
      return reply(429, "The local model is busy. Try again shortly.", { "retry-after": "5" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), generationTimeoutMs);
    const cancel = () => controller.abort();
    response.once("close", cancel);
    try {
      if (Date.now() < capacityUnavailableUntil) return reply(503, "Local model is over capacity: insufficient memory.", { "retry-after": String(Math.ceil((capacityUnavailableUntil - Date.now()) / 1000)) });
      const result = await fetcher(`${upstream}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, redirect: "error", body: JSON.stringify(forwarded),
      });
      if (!result.ok) {
        const text = await boundedErrorText(result).catch(() => "");
        if (result.status >= 500 && /out of memory|requires more (?:system |gpu )?memory|insufficient (?:system |gpu )?memory|not enough (?:system |gpu )?memory|cuda.*alloc/iu.test(text)) {
          capacityUnavailableUntil = Date.now() + capacityCooldownMs;
          return reply(503, "Local model is over capacity: insufficient memory.", { "retry-after": String(Math.ceil(capacityCooldownMs / 1000)) });
        }
        // The model server's 4xx (an unsupported tool call, a bad request) goes
        // back as it is, so Atlas can adapt; a server failure is not detailed.
        if (result.status >= 400 && result.status < 500) {
          response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
          return response.end(text || JSON.stringify({ error: { message: "Local model refused the request" } }));
        }
        return reply(502, "Local model request failed");
      }
      const streaming = (result.headers.get("content-type") ?? "").includes("text/event-stream");
      response.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json", "cache-control": "no-store", "x-atlas-provider": "local", "x-atlas-model": body.model, ...(streaming ? { "x-accel-buffering": "no" } : {}) });
      if (!result.body) return response.end();
      for await (const chunk of Readable.fromWeb(result.body)) {
        if (response.destroyed) break;
        if (!response.write(chunk)) await new Promise((resolve) => {
          const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
          response.once("drain", done);
          response.once("close", done);
        });
      }
      return response.end();
    } catch {
      if (response.headersSent) return response.end();
      return reply(504, "Local model did not answer in time");
    } finally {
      clearTimeout(timer);
      response.off("close", cancel);
      release();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createGateway({
    token: process.env.ATLAS_MODEL_API_KEY,
    models: process.env.ATLAS_GATEWAY_MODELS || process.env.ATLAS_CHAT_MODEL,
    upstream: process.env.ATLAS_GATEWAY_UPSTREAM || "http://127.0.0.1:11434",
    concurrency: Number(process.env.ATLAS_GATEWAY_CONCURRENCY || 1),
  });
  // Receiving a request body is quick; generation time is bounded separately.
  server.requestTimeout = 60_000;
  server.listen(Number(process.env.ATLAS_GATEWAY_PORT || 11435), "127.0.0.1", () => console.log("Atlas model gateway ready on loopback."));
}
