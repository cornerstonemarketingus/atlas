import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { SUPPORTED_PROTOCOL_VERSIONS } from "./server.mjs";

/**
 * Streamable HTTP transport for the Atlas MCP server (spec 2025-06-18).
 *
 *   - binds loopback only (127.0.0.1 / ::1 / localhost); anything else throws;
 *   - every request needs `Authorization: Bearer <token>`; tokens are compared
 *     in constant time over their SHA-256 digests, and each token maps to one
 *     principal (tenant, user, granted permissions);
 *   - `Origin`, when present, must be a loopback origin (DNS-rebinding guard);
 *   - `initialize` opens a session (`Mcp-Session-Id`); the session is bound to
 *     the token that opened it, so another token cannot ride it;
 *   - JSON responses only; notifications get 202; GET is 405 (no
 *     server-initiated stream); DELETE ends the session; batches are refused.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const sha = (value) => createHash("sha256").update(String(value)).digest();

/** Constant-time token lookup over every configured token (no early exit). */
export function createTokenResolver(tokens) {
  const entries = (tokens ?? []).map(({ token, principal }) => {
    if (typeof token !== "string" || token.length < 16) throw new Error("Atlas MCP HTTP tokens must be strings of at least 16 characters.");
    if (!principal?.tenantId || !principal?.userId) throw new Error("Every Atlas MCP HTTP token needs a principal with tenantId and userId.");
    return { hash: sha(token), principal: Object.freeze({ ...principal, grantedPermissions: Object.freeze([...(principal.grantedPermissions ?? [])]) }) };
  });
  return (presented) => {
    const candidate = sha(presented ?? "");
    let match = null;
    for (const entry of entries) {
      if (timingSafeEqual(candidate, entry.hash) && match === null) match = entry;
    }
    return match ? { principal: match.principal, tokenHash: match.hash.toString("hex") } : null;
  };
}

function isLoopbackOrigin(origin) {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {import("./server.mjs").AtlasMcpServer} options.server
 * @param {Array<{token: string, principal: object}>} options.tokens
 * @param {string} [options.host]  loopback only
 * @param {number} [options.port]  0 = ephemeral
 * @param {string} [options.path]
 * @param {number} [options.maxBodyBytes]
 * @param {number} [options.maxSessions]
 */
export function createAtlasMcpHttpServer({ server, tokens, host = "127.0.0.1", port = 0, path = "/mcp", maxBodyBytes = 1024 * 1024, maxSessions = 1000 }) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`The Atlas MCP HTTP server binds loopback only; refusing '${host}'.`);
  const resolveToken = createTokenResolver(tokens);
  const sessions = new Map(); // id -> { tokenHash, protocolVersion }

  const send = (res, status, body, headers = {}) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "cache-control": "no-store",
      ...headers,
    });
    res.end(payload);
  };
  const jsonError = (res, status, code, message, headers) => send(res, status, { jsonrpc: "2.0", id: null, error: { code, message } }, headers);

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) { jsonError(res, 404, -32601, "Not found"); return; }
    if (req.headers.origin !== undefined && !isLoopbackOrigin(req.headers.origin)) { jsonError(res, 403, -32600, "Forbidden origin"); return; }

    const auth = String(req.headers.authorization ?? "");
    const match = /^Bearer ([\x21-\x7e]{1,4096})$/.exec(auth);
    const identity = match ? resolveToken(match[1]) : null;
    if (!identity) { jsonError(res, 401, -32001, "Unauthorized", { "www-authenticate": 'Bearer realm="atlas-mcp"' }); req.resume(); return; }

    const sessionId = req.headers["mcp-session-id"];
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    const sessionOk = session && session.tokenHash === identity.tokenHash;

    if (req.method === "GET") { send(res, 405, undefined, { allow: "POST, DELETE" }); req.resume(); return; }
    if (req.method === "DELETE") {
      req.resume();
      if (!sessionOk) { jsonError(res, 404, -32001, "Session not found"); return; }
      sessions.delete(sessionId);
      send(res, 204);
      return;
    }
    if (req.method !== "POST") { send(res, 405, undefined, { allow: "POST, DELETE" }); req.resume(); return; }

    const version = req.headers["mcp-protocol-version"];
    if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) { jsonError(res, 400, -32600, "Unsupported MCP-Protocol-Version"); req.resume(); return; }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBodyBytes) { aborted = true; jsonError(res, 413, -32600, "Request too large", { connection: "close" }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (aborted) return;
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { jsonError(res, 400, -32700, "Parse error"); return; }
      if (Array.isArray(message)) { jsonError(res, 400, -32600, "Batching is not supported"); return; }
      const isInitialize = message?.method === "initialize";
      if (!isInitialize) {
        if (typeof sessionId !== "string") { jsonError(res, 400, -32600, "Missing Mcp-Session-Id"); return; }
        if (!sessionOk) { jsonError(res, 404, -32001, "Session not found"); return; }
      }
      let response;
      try {
        response = await server.handle(message, identity.principal);
      } catch {
        jsonError(res, 500, -32603, "Internal error");
        return;
      }
      const headers = {};
      if (isInitialize && response?.result) {
        if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
        const id = randomUUID();
        sessions.set(id, { tokenHash: identity.tokenHash, protocolVersion: response.result.protocolVersion });
        headers["mcp-session-id"] = id;
      }
      if (response === undefined) { send(res, 202, undefined, headers); return; }
      send(res, 200, response, headers);
    });
  });
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;

  return {
    httpServer,
    sessions,
    get url() {
      const address = httpServer.address();
      if (!address || typeof address === "string") return null;
      const h = address.family === "IPv6" ? `[${address.address}]` : address.address;
      return `http://${h}:${address.port}${path}`;
    },
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => { httpServer.off("error", reject); resolve(this.url); });
      });
    },
    close() {
      return new Promise((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      });
    },
  };
}
