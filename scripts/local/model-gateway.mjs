import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Expose only authenticated inference, never Ollama's management/download API. */
export function createGateway({ token, model, upstream = "http://127.0.0.1:11434", fetcher = fetch }) {
  if (!token || token.length < 32 || !model) throw new Error("A model and a 32+ character gateway token are required");
  const expected = Buffer.from(`Bearer ${token}`);
  let active = false;
  return http.createServer(async (request, response) => {
    const reply = (status, data) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(data)); };
    const supplied = Buffer.from(request.headers.authorization || "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: "Authentication required" });
    if (request.method === "GET" && request.url === "/v1/models") return reply(200, { object: "list", data: [{ id: model, object: "model", owned_by: "local" }] });
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return reply(404, { error: "Not found" });
    if (active) return reply(429, { error: "Model is busy. Try again shortly." });
    active = true;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128000) { reply(413, { error: "Request too large" }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(400, { error: "Invalid JSON" }); }
      if (body.model !== model || !Array.isArray(body.messages) || body.messages.length > 30 || body.stream === true) return reply(400, { error: "Unsupported model or request" });
      const result = await fetcher(`${upstream}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ model, messages: body.messages, stream: false, temperature: 0.2, max_tokens: Math.min(1200, Math.max(1, Number(body.max_tokens) || 1200)) }),
      });
      if (!result.ok) return reply(502, { error: "Local model request failed" });
      reply(200, await result.json());
    } catch { reply(504, { error: "Local model did not answer in time" }); }
    finally { active = false; }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createGateway({ token: process.env.ATLAS_MODEL_API_KEY, model: process.env.ATLAS_CHAT_MODEL });
  server.requestTimeout = 30000;
  server.listen(Number(process.env.ATLAS_GATEWAY_PORT || 11435), "127.0.0.1", () => console.log("Atlas model gateway ready on loopback."));
}
