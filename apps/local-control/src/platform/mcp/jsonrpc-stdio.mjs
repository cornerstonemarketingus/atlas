import { spawn } from "node:child_process";

/**
 * Minimal Model Context Protocol client (blueprint §8), zero dependencies.
 *
 * Two layers:
 *   - a *transport* moves JSON-RPC 2.0 messages. `createStdioTransport` spawns
 *     a server process (argv only, never a shell) with a scrubbed environment
 *     and speaks newline-delimited JSON over its stdio; `createInMemoryTransport`
 *     routes messages to a handler function for tests.
 *   - `McpClient` owns request ids, per-request timeouts, notifications and the
 *     MCP handshake (`initialize` → `notifications/initialized`), plus
 *     `tools/list` (paginated) and `tools/call`.
 *
 * Nothing here decides whether a call is allowed; that is the gateway's job.
 * MCP is a protocol, not a security boundary.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Variables a server process gets by default; everything else must be granted. */
const BASELINE_ENV = Object.freeze(["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class McpProtocolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Builds the child environment: the baseline variables copied from the host,
 * then explicitly granted host variables (`inheritEnv`), then explicit values
 * (`env`). Host secrets never leak by default.
 */
export function buildScrubbedEnv({ env = {}, inheritEnv = [], hostEnv = process.env, baseline = BASELINE_ENV } = {}) {
  const out = {};
  for (const name of [...baseline, ...inheritEnv]) {
    if (!ENV_NAME.test(name)) throw new McpProtocolError("INVALID_ENV", `Invalid environment variable name '${name}'.`);
    if (typeof hostEnv[name] === "string") out[name] = hostEnv[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) throw new McpProtocolError("INVALID_ENV", `Invalid environment variable name '${name}'.`);
    if (typeof value !== "string") throw new McpProtocolError("INVALID_ENV", `Environment variable '${name}' must be a string.`);
    out[name] = value;
  }
  return out;
}

/**
 * Spawns `argv[0]` with `argv.slice(1)`; `shell` is always false so argv is
 * never reinterpreted. Returns a transport: { send, onMessage, onClose, close, pid, stderrTail }.
 */
export function createStdioTransport({
  argv,
  cwd = undefined,
  env = {},
  inheritEnv = [],
  hostEnv = process.env,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  maxStderrBytes = 16 * 1024,
  killGraceMs = 2000,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string" && part.length > 0)) {
    throw new McpProtocolError("INVALID_ARGV", "An MCP stdio server needs a non-empty argv of strings.");
  }
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: buildScrubbedEnv({ env, inheritEnv, hostEnv }),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let messageHandler = () => {};
  let closeHandler = () => {};
  let closed = false;
  let buffer = "";
  let stderr = "";

  const finish = (reason) => {
    if (closed) return;
    closed = true;
    closeHandler(reason);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > maxMessageBytes) {
        transport.close();
        finish(new McpProtocolError("MESSAGE_TOO_LARGE", `Server message exceeded ${maxMessageBytes} bytes.`));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // A server that writes non-JSON to stdout is broken; ignore the line
        // rather than letting it be interpreted as anything.
        continue;
      }
      messageHandler(message);
    }
    if (Buffer.byteLength(buffer) > maxMessageBytes) {
      buffer = "";
      transport.close();
      finish(new McpProtocolError("MESSAGE_TOO_LARGE", `Server message exceeded ${maxMessageBytes} bytes.`));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-maxStderrBytes);
  });
  child.stdin.on("error", () => {});
  child.on("error", (error) => finish(new McpProtocolError("SPAWN_FAILED", error.message)));
  child.on("exit", (code, signal) => finish(new McpProtocolError("SERVER_EXITED", `MCP server exited (code ${code}, signal ${signal}).`)));

  const transport = {
    kind: "stdio",
    get pid() { return child.pid; },
    get stderrTail() { return stderr; },
    send(message) {
      if (closed || !child.stdin.writable) throw new McpProtocolError("TRANSPORT_CLOSED", "MCP transport is closed.");
      const line = JSON.stringify(message);
      if (Buffer.byteLength(line) > maxMessageBytes) {
        throw new McpProtocolError("MESSAGE_TOO_LARGE", `Outgoing message exceeded ${maxMessageBytes} bytes.`);
      }
      child.stdin.write(`${line}\n`);
    },
    onMessage(handler) { messageHandler = handler; },
    onClose(handler) { closeHandler = handler; },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try { child.stdin.end(); } catch { /* already closed */ }
      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, killGraceMs);
      const hardTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, killGraceMs * 2);
      await exited;
      clearTimeout(timer);
      clearTimeout(hardTimer);
    },
  };
  return transport;
}

/**
 * In-memory transport for tests. `handler(message, { notify })` receives every
 * client message and returns (or resolves) the response message, or
 * `undefined` for notifications / deliberately unanswered requests.
 */
export function createInMemoryTransport(handler) {
  let messageHandler = () => {};
  let closeHandler = () => {};
  let closed = false;
  const deliver = (message) => {
    if (!closed) queueMicrotask(() => messageHandler(JSON.parse(JSON.stringify(message))));
  };
  return {
    kind: "memory",
    sent: [],
    send(message) {
      if (closed) throw new McpProtocolError("TRANSPORT_CLOSED", "MCP transport is closed.");
      const copy = JSON.parse(JSON.stringify(message));
      this.sent.push(copy);
      Promise.resolve(handler(copy, { notify: deliver })).then((response) => {
        if (response !== undefined) deliver(response);
      }, () => {});
    },
    onMessage(fn) { messageHandler = fn; },
    onClose(fn) { closeHandler = fn; },
    async close() {
      if (closed) return;
      closed = true;
      closeHandler(new McpProtocolError("TRANSPORT_CLOSED", "MCP transport closed."));
    },
  };
}

/** JSON-RPC 2.0 + MCP handshake over any transport. */
export class McpClient {
  constructor({
    transport,
    clientInfo = { name: "atlas-mcp-gateway", version: "0.1.0" },
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onNotification = () => {},
    maxPages = 50,
  }) {
    if (!transport) throw new McpProtocolError("NO_TRANSPORT", "McpClient needs a transport.");
    this.transport = transport;
    this.clientInfo = clientInfo;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onNotification = onNotification;
    this.maxPages = maxPages;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.protocolVersion = null;
    transport.onMessage((message) => this.#receive(message));
    transport.onClose((reason) => this.#failAll(reason ?? new McpProtocolError("TRANSPORT_CLOSED", "MCP transport closed.")));
  }

  #receive(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
    const isResponse = "id" in message && ("result" in message || "error" in message) && !("method" in message);
    if (isResponse) {
      const entry = this.pending.get(message.id);
      if (!entry) return; // late or unsolicited response: dropped
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const { code, message: text, data } = message.error;
        entry.reject(new McpProtocolError("RPC_ERROR", String(text ?? "MCP server error").slice(0, 500), { rpcCode: code, data }));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      if ("id" in message) {
        // Server→client requests (sampling, roots, elicitation) are not
        // supported: answer with method-not-found instead of hanging it.
        try {
          this.transport.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported by client" } });
        } catch { /* closed */ }
        return;
      }
      try { this.onNotification(message); } catch { /* observer errors never break the client */ }
    }
  }

  #failAll(reason) {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }

  request(method, params = undefined, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new McpProtocolError("TRANSPORT_CLOSED", "MCP client is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
        reject(new McpProtocolError("TIMEOUT", `MCP request '${method}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        const message = { jsonrpc: "2.0", id, method };
        if (params !== undefined) message.params = params;
        this.transport.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = undefined) {
    if (this.closed) return;
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    try { this.transport.send(message); } catch { /* closed */ }
  }

  async initialize({ timeoutMs } = {}) {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    }, { timeoutMs });
    if (!result || typeof result !== "object" || typeof result.protocolVersion !== "string") {
      throw new McpProtocolError("BAD_HANDSHAKE", "MCP server returned an invalid initialize result.");
    }
    this.protocolVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo ?? null;
    this.serverCapabilities = result.capabilities ?? {};
    this.notify("notifications/initialized");
    return result;
  }

  /** Follows `nextCursor` until exhausted (bounded by `maxPages`). */
  async listTools({ timeoutMs } = {}) {
    const tools = [];
    let cursor;
    for (let page = 0; page < this.maxPages; page += 1) {
      const result = await this.request("tools/list", cursor === undefined ? {} : { cursor }, { timeoutMs });
      if (!result || !Array.isArray(result.tools)) throw new McpProtocolError("BAD_RESPONSE", "tools/list returned no tools array.");
      tools.push(...result.tools);
      if (typeof result.nextCursor !== "string" || !result.nextCursor) return tools;
      cursor = result.nextCursor;
    }
    throw new McpProtocolError("TOO_MANY_PAGES", `tools/list exceeded ${this.maxPages} pages.`);
  }

  callTool(name, args = {}, { timeoutMs } = {}) {
    return this.request("tools/call", { name, arguments: args }, { timeoutMs });
  }

  async close() {
    this.#failAll(new McpProtocolError("TRANSPORT_CLOSED", "MCP client closed."));
    await this.transport.close();
  }
}
