// In-test streamable HTTP MCP server. Answers with application/json or
// text/event-stream (with a progress notification before the response),
// issues Mcp-Session-Id on initialize, and records every request (method,
// headers) so tests can assert what the client sent.
import http from "node:http";
import { randomUUID } from "node:crypto";

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const TOOLS = [
  { name: "echo", description: "Echo text.", inputSchema: obj({ text: { type: "string" } }, ["text"]) },
  { name: "whoami", description: "Reports the Authorization header it saw.", inputSchema: obj({}) },
  { name: "big", description: "Returns a large payload.", inputSchema: obj({}) },
  { name: "slow", description: "Sleeps.", inputSchema: obj({ ms: { type: "integer" } }, ["ms"]) },
];

export async function startTestHttpServer({ mode = "json", token = null } = {}) {
  const state = { mode, requests: [], sessions: new Set(), expireAlways: false, initializeCount: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let msg = null;
      try { msg = body ? JSON.parse(body) : null; } catch { /* ignore */ }
      state.requests.push({ method: req.method, rpc: msg?.method ?? null, headers: { ...req.headers } });
      if (token !== null && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "www-authenticate": "Bearer" }); res.end(); return;
      }
      if (req.method === "DELETE") { state.sessions.delete(req.headers["mcp-session-id"]); res.writeHead(204); res.end(); return; }
      if (!msg) { res.writeHead(400); res.end(); return; }
      const headers = {};
      if (msg.method === "initialize") {
        state.initializeCount += 1;
        const id = randomUUID();
        state.sessions.add(id);
        headers["mcp-session-id"] = id;
      } else {
        const sid = req.headers["mcp-session-id"];
        if (state.expireAlways || !state.sessions.has(sid)) { res.writeHead(404); res.end(); return; }
      }
      if (!("id" in msg)) { res.writeHead(202, headers); res.end(); return; }
      const result = await answer(msg, req);
      const response = { jsonrpc: "2.0", id: msg.id, ...result };
      if (state.mode === "sse") {
        res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
        res.write(": comment line\n\n");
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
        const text = JSON.stringify(response);
        // Split the response across two data lines of one event, and two TCP writes.
        const half = text.indexOf(",") + 1; // structural split point: SSE joins data lines with "\n"
        res.write(`id: 1\ndata: ${text.slice(0, half)}\n`);
        setTimeout(() => res.end(`data: ${text.slice(half)}\n\n`), 5);
      } else {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify(response));
      }
    });
  });

  async function answer(msg, req) {
    switch (msg.method) {
      case "initialize": return { result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http-test" } } };
      case "tools/list": return { result: { tools: TOOLS } };
      case "tools/call": {
        const { name, arguments: args } = msg.params;
        if (name === "echo") return { result: { content: [{ type: "text", text: args.text }] } };
        if (name === "whoami") return { result: { content: [{ type: "text", text: `auth=${req.headers.authorization ?? "none"}` }] } };
        if (name === "big") return { result: { content: [{ type: "text", text: "x".repeat(200_000) }] } };
        if (name === "slow") { await new Promise((r) => setTimeout(r, args.ms)); return { result: { content: [{ type: "text", text: "done" }] } }; }
        return { error: { code: -32602, message: "unknown tool" } };
      }
      default: return { error: { code: -32601, message: "Method not found" } };
    }
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    state,
    rotate() { state.sessions.clear(); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
