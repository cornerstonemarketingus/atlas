import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";

import { MCP_PROTOCOL_VERSION, McpProtocolError } from "./jsonrpc-stdio.mjs";

/**
 * Streamable HTTP MCP client transport (MCP spec 2025-06-18, blueprint §8).
 *
 * Every client message is POSTed to one endpoint. The server answers with
 * `application/json` (one message), `text/event-stream` (a stream of messages
 * ending with the response), or `202 Accepted` for notifications. The session
 * id the server assigns on `initialize` (`Mcp-Session-Id`) is echoed on every
 * later request together with `MCP-Protocol-Version`.
 *
 * Security properties:
 *   - SSRF guard: only `https:` unless the target is loopback AND loopback was
 *     explicitly allowed; private / link-local / CGNAT / metadata / multicast
 *     addresses are refused unless their host is allowlisted. The check runs
 *     inside the socket's DNS lookup, so the address that is validated is the
 *     address that is connected to (no DNS-rebinding window). Redirects are
 *     never followed.
 *   - The bearer token comes from `getToken()` per request and is only ever
 *     written into the Authorization header: error messages never include it.
 *   - Every POST has a timeout and the response body is capped at
 *     `maxResponseBytes`.
 *
 * `send()` returns a promise; McpClient rejects the matching pending request
 * when it rejects. Errors carry `retryable: true` only when the request is
 * known not to have been delivered (connection refused, session expired), so
 * a caller can safely retry once without double-executing a tool.
 */

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc * 256) + Number(part), 0);
}

const V4_BLOCKS = [
  // [cidr base, prefix, class]
  ["0.0.0.0", 8, "private"],        // "this" network
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "private"],    // CGNAT
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "private"],   // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "private"],
  ["192.0.2.0", 24, "private"],     // TEST-NET-1
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "private"],    // benchmarking
  ["198.51.100.0", 24, "private"],  // TEST-NET-2
  ["203.0.113.0", 24, "private"],   // TEST-NET-3
  ["224.0.0.0", 4, "private"],      // multicast
  ["240.0.0.0", 4, "private"],      // reserved + broadcast
];

function classifyV4(ip) {
  const value = ipv4ToInt(ip);
  for (const [base, prefix, kind] of V4_BLOCKS) {
    const size = 2 ** (32 - prefix);
    const start = ipv4ToInt(base);
    if (value >= start && value < start + size) return kind;
  }
  return "public";
}

function expandV6(ip) {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4).
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = ipv4ToInt(dotted[1]);
    text = text.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = tail === null ? 0 : 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts].map((p) => parseInt(p, 16));
  return parts.length === 8 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 0xffff) ? parts : null;
}

function classifyV6(ip) {
  const parts = expandV6(ip);
  if (!parts) return "private"; // unparseable: fail closed
  if (parts.every((p) => p === 0)) return "private";                     // ::
  if (parts.slice(0, 7).every((p) => p === 0) && parts[7] === 1) return "loopback"; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible / NAT64 forms carry an IPv4 address.
  const v4 = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
  if (parts.slice(0, 5).every((p) => p === 0) && (parts[5] === 0xffff || parts[5] === 0)) return classifyV4(v4);
  if (parts[0] === 0x64 && parts[1] === 0xff9b) return classifyV4(v4);
  if ((parts[0] & 0xfe00) === 0xfc00) return "private";  // fc00::/7 unique local
  if ((parts[0] & 0xffc0) === 0xfe80) return "private";  // fe80::/10 link-local
  if ((parts[0] & 0xffc0) === 0xfec0) return "private";  // fec0::/10 site-local (deprecated)
  if ((parts[0] & 0xff00) === 0xff00) return "private";  // multicast
  if (parts[0] === 0x2001 && parts[1] === 0x0db8) return "private"; // documentation
  return "public";
}

/** "loopback" | "private" | "public" for an IP literal. */
export function classifyAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return classifyV4(ip);
  if (family === 6) return classifyV6(ip);
  return "private";
}

function normalizeHost(hostname) {
  return String(hostname).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function checkAddress(address, host, { allowLoopback, allowPrivateHosts }) {
  const kind = classifyAddress(address);
  if (kind === "public") return null;
  if (kind === "loopback") {
    return allowLoopback ? null : `loopback address ${address} is not allowed (set allowLoopback)`;
  }
  const allow = new Set(allowPrivateHosts.map(normalizeHost));
  if (allow.has(host) || allow.has(normalizeHost(address))) return null;
  return `private address ${address} for host '${host}' is not allowlisted`;
}

/**
 * Validates a server URL before any connection is made. IP literals are
 * checked here; hostnames are checked again at connect time by the guarded
 * lookup (see `guardedLookup`).
 * @returns {URL}
 */
export function assertSafeUrl(rawUrl, { allowLoopback = false, allowPrivateHosts = [] } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new McpProtocolError("SSRF_BLOCKED", "MCP server URL is not a valid URL."); }
  if (url.username || url.password) throw new McpProtocolError("SSRF_BLOCKED", "MCP server URL must not embed credentials.");
  const host = normalizeHost(url.hostname);
  const literalKind = isIP(host) ? classifyAddress(host) : (host === "localhost" || host.endsWith(".localhost") ? "loopback" : null);
  if (url.protocol === "http:") {
    if (!(allowLoopback && literalKind === "loopback")) {
      throw new McpProtocolError("SSRF_BLOCKED", "MCP over plain http is only allowed to an explicitly allowed loopback address.");
    }
  } else if (url.protocol !== "https:") {
    throw new McpProtocolError("SSRF_BLOCKED", `MCP server URL scheme '${url.protocol}' is not allowed.`);
  }
  if (isIP(host)) {
    const problem = checkAddress(host, host, { allowLoopback, allowPrivateHosts });
    if (problem) throw new McpProtocolError("SSRF_BLOCKED", `Refusing MCP server URL: ${problem}.`);
  } else if (literalKind === "loopback" && !allowLoopback) {
    throw new McpProtocolError("SSRF_BLOCKED", "Refusing MCP server URL: localhost is not allowed (set allowLoopback).");
  }
  return url;
}

/**
 * A `lookup` for http.request that refuses to hand back any address the
 * policy forbids, so the validated address is the connected address.
 */
export function guardedLookup({ allowLoopback = false, allowPrivateHosts = [], lookup = dnsLookup } = {}) {
  return (hostname, options, callback) => {
    const host = normalizeHost(hostname);
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }];
      if (list.length === 0) return callback(new McpProtocolError("SSRF_BLOCKED", `Host '${host}' resolved to no address.`));
      for (const { address } of list) {
        const problem = checkAddress(address, host, { allowLoopback, allowPrivateHosts });
        if (problem) return callback(new McpProtocolError("SSRF_BLOCKED", `Refusing MCP server connection: ${problem}.`));
      }
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/** Incremental text/event-stream parser; calls `onEvent({ event, data, id })`. */
export function createSseParser(onEvent) {
  let buffer = "";
  let data = [];
  let event = "message";
  let id = null;
  const dispatch = () => {
    if (data.length) onEvent({ event, data: data.join("\n"), id });
    data = [];
    event = "message";
  };
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer.startsWith("\r\n", index) ? 2 : 1));
        if (line === "") { dispatch(); continue; }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "event") event = value || "message";
        else if (field === "id") id = value;
      }
    },
    end() { if (buffer) this.push("\n"); dispatch(); },
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const RETRYABLE_NET = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * @param {object} options
 * @param {string} options.url                  the single MCP endpoint
 * @param {() => (string|null|Promise<string|null>)} [options.getToken]  bearer token source (per request)
 * @param {boolean} [options.allowLoopback]     permit loopback (and plain http to loopback)
 * @param {string[]} [options.allowPrivateHosts] hostnames / IPs allowed to resolve to private addresses
 * @param {number} [options.timeoutMs]          per POST
 * @param {number} [options.maxResponseBytes]   per response body
 * @param {Function} [options.lookup]           DNS lookup (tests)
 */
export function createStreamableHttpTransport({
  url,
  getToken = null,
  allowLoopback = false,
  allowPrivateHosts = [],
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  headers: extraHeaders = {},
  lookup = dnsLookup,
} = {}) {
  const target = assertSafeUrl(url, { allowLoopback, allowPrivateHosts });
  const client = target.protocol === "https:" ? https : http;
  const hostLookup = guardedLookup({ allowLoopback, allowPrivateHosts, lookup });
  for (const name of Object.keys(extraHeaders)) {
    if (/^(authorization|mcp-session-id|mcp-protocol-version|host|content-length)$/i.test(name)) {
      throw new McpProtocolError("INVALID_HEADERS", `Header '${name}' is managed by the transport.`);
    }
  }

  let messageHandler = () => {};
  let closeHandler = () => {};
  let closed = false;
  let sessionId = null;
  let protocolVersion = null;
  const initializeIds = new Set();
  const inflight = new Set();

  const finish = (reason) => {
    if (closed) return;
    closed = true;
    for (const req of inflight) req.destroy();
    inflight.clear();
    closeHandler(reason);
  };

  const deliver = (message) => {
    if (closed || !message || typeof message !== "object") return;
    if ("id" in message && initializeIds.has(message.id) && message.result && typeof message.result.protocolVersion === "string") {
      initializeIds.delete(message.id);
      protocolVersion = message.result.protocolVersion;
    }
    messageHandler(message);
  };

  const fail = (code, message, { retryable = false, fatal = false, details } = {}) => {
    const error = new McpProtocolError(code, message, details);
    if (retryable) error.retryable = true;
    if (fatal) finish(error);
    return error;
  };

  async function buildHeaders(body) {
    const out = {
      ...extraHeaders,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": Buffer.byteLength(body),
    };
    if (sessionId) out["mcp-session-id"] = sessionId;
    if (protocolVersion) out["mcp-protocol-version"] = protocolVersion;
    if (getToken) {
      let token;
      try { token = await getToken(); } catch (error) {
        throw fail(error?.code === "CREDENTIAL_UNAVAILABLE" ? "CREDENTIAL_UNAVAILABLE" : "CREDENTIAL_ERROR", "Could not resolve the MCP server credential.");
      }
      if (typeof token !== "string" || !token || /[\r\n]/.test(token)) {
        throw fail("CREDENTIAL_UNAVAILABLE", "No credential is available for this MCP server.");
      }
      out.authorization = `Bearer ${token}`;
    }
    return out;
  }

  function post(message) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > maxResponseBytes) {
        reject(fail("MESSAGE_TOO_LARGE", `Outgoing message exceeded ${maxResponseBytes} bytes.`));
        return;
      }
      buildHeaders(body).then((headers) => {
        if (closed) { reject(fail("TRANSPORT_CLOSED", "MCP transport is closed.", { retryable: true })); return; }
        const req = client.request(target, { method: "POST", headers, lookup: hostLookup, timeout: timeoutMs });
        inflight.add(req);
        let settled = false;
        const settle = (error) => {
          if (settled) return;
          settled = true;
          inflight.delete(req);
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => {
          settle(fail("TIMEOUT", `MCP HTTP request timed out after ${timeoutMs}ms.`));
          req.destroy();
        }, timeoutMs);
        req.on("timeout", () => { settle(fail("TIMEOUT", `MCP HTTP request timed out after ${timeoutMs}ms.`)); req.destroy(); });
        req.on("error", (error) => {
          if (error instanceof McpProtocolError) { settle(error); return; }
          const retryable = RETRYABLE_NET.has(error?.code);
          settle(fail(retryable ? "CONNECTION_FAILED" : "NETWORK_ERROR", `MCP HTTP connection failed (${error?.code ?? "error"}).`, { retryable, fatal: retryable }));
        });
        req.on("response", (res) => {
          const status = res.statusCode ?? 0;
          const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          const newSession = res.headers["mcp-session-id"];
          if (typeof newSession === "string" && message.method === "initialize" && status < 300) {
            if (!/^[\x21-\x7e]{1,256}$/.test(newSession)) { res.resume(); settle(fail("BAD_RESPONSE", "Server sent an invalid Mcp-Session-Id.")); return; }
            sessionId = newSession;
          }
          if (status === 404 && sessionId && message.method !== "initialize") {
            res.resume();
            settle(fail("SESSION_EXPIRED", "MCP session expired; the client must re-initialize.", { retryable: true, fatal: true }));
            return;
          }
          if (status === 401 || status === 403) { res.resume(); settle(fail("AUTH_FAILED", `MCP server refused the credential (HTTP ${status}).`)); return; }
          if (status === 202) { res.resume(); settle(); return; }
          if (status < 200 || status >= 300) { res.resume(); settle(fail("HTTP_ERROR", `MCP server answered HTTP ${status}.`, { details: { status } })); return; }

          let received = 0;
          const guard = (chunk) => {
            received += Buffer.byteLength(chunk);
            if (received > maxResponseBytes) {
              settle(fail("MESSAGE_TOO_LARGE", `MCP response exceeded ${maxResponseBytes} bytes.`));
              req.destroy();
              return false;
            }
            return true;
          };
          res.setEncoding("utf8");
          if (type === "text/event-stream") {
            const parser = createSseParser(({ data }) => {
              let parsed;
              try { parsed = JSON.parse(data); } catch { return; }
              deliver(parsed);
              if ("id" in message && parsed && parsed.id === message.id && ("result" in parsed || "error" in parsed)) {
                // Our response arrived; the server may keep the stream open, we do not need it.
                settle();
                res.destroy();
              }
            });
            res.on("data", (chunk) => { if (guard(chunk)) parser.push(chunk); });
            res.on("end", () => { parser.end(); settle(); });
            res.on("error", () => settle());
            res.on("close", () => settle());
            return;
          }
          if (type === "application/json") {
            let text = "";
            res.on("data", (chunk) => { if (guard(chunk)) text += chunk; });
            res.on("end", () => {
              if (settled) return;
              if (!text.trim()) { settle(); return; }
              let parsed;
              try { parsed = JSON.parse(text); } catch { settle(fail("BAD_RESPONSE", "MCP server returned invalid JSON.")); return; }
              for (const item of Array.isArray(parsed) ? parsed : [parsed]) deliver(item);
              settle();
            });
            res.on("error", () => settle(fail("NETWORK_ERROR", "MCP HTTP response was interrupted.")));
            return;
          }
          res.resume();
          settle(fail("BAD_RESPONSE", `MCP server answered with unsupported content type '${type.slice(0, 64)}'.`));
        });
        req.end(body);
      }, reject);
    });
  }

  return {
    kind: "http",
    get sessionId() { return sessionId; },
    get protocolVersion() { return protocolVersion; },
    get url() { return target.href; },
    send(message) {
      if (closed) throw fail("TRANSPORT_CLOSED", "MCP transport is closed.", { retryable: true });
      if (message?.method === "initialize" && "id" in message) {
        initializeIds.add(message.id);
        protocolVersion = null;
        sessionId = null;
      }
      return post(message);
    },
    onMessage(handler) { messageHandler = handler; },
    onClose(handler) { closeHandler = handler; },
    async close() {
      if (closed) return;
      const id = sessionId;
      finish(new McpProtocolError("TRANSPORT_CLOSED", "MCP transport closed."));
      if (!id) return;
      // Best effort: tell the server the session is over.
      await new Promise((resolve) => {
        buildHeaders("").then((headers) => {
          delete headers["content-type"];
          const req = client.request(target, { method: "DELETE", headers: { ...headers, "mcp-session-id": id }, lookup: hostLookup, timeout: 2000 });
          req.on("response", (res) => { res.resume(); resolve(); });
          req.on("error", () => resolve());
          req.on("timeout", () => { req.destroy(); resolve(); });
          req.end();
        }, () => resolve());
      });
    },
  };
}

export { MCP_PROTOCOL_VERSION };
