import { digest, validateSchema, RISK_LEVELS } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { createRateLimiter } from "../../rate-limit.mjs";
import { McpClient } from "./jsonrpc-stdio.mjs";
import { createStreamableHttpTransport } from "./http-transport.mjs";

/**
 * MCP client gateway (blueprint §8).
 *
 * Every MCP server is untrusted input. The gateway therefore:
 *   - treats tool descriptions as data: control characters stripped, length
 *     capped, prompt-injection markers neutralized and the tool flagged;
 *   - authorizes EVERY call (tenant ownership, allowedTools glob, injected
 *     `authorize(ctx)` callback, flagged-tool rule) before anything is sent;
 *   - validates arguments against the discovered inputSchema before sending;
 *   - rate limits per tenant+server and enforces a per-call timeout;
 *   - sanitizes results: only text / structuredContent / image survive, sizes
 *     are capped, secret-like strings are redacted, injection markers flagged,
 *     and the whole thing is wrapped `{ untrusted: true, ... }`;
 *   - audits every discover and call (success, denial, error) with an args
 *     digest, never raw args;
 *   - resolves server credentials ONLY through the injected
 *     `credentialProvider(tenantId, serverId, credentialsScope)`, always with
 *     the registration's own tenant / server / scope (never caller input). A
 *     server that requires a credential and gets none is denied before any
 *     connection. Credential values are scrubbed from results, errors and
 *     audit events and never returned;
 *   - re-creates a dead client at most once per call, after a backoff, and
 *     retries a call only when the failure proves it was never delivered.
 */

export class McpGatewayError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "McpGatewayError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const DEFAULT_LIMITS = Object.freeze({
  maxDescriptionChars: 1024,
  maxTextBytes: 64 * 1024,
  maxResultBytes: 256 * 1024,
  maxStructuredBytes: 64 * 1024,
  maxImageBytes: 512 * 1024,
  maxContentItems: 32,
  maxTools: 256,
});

export const ALLOWED_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const SERVER_ID = /^[a-z][a-z0-9_-]{0,63}$/;

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

// C0/C1 controls (tab/newline handled separately), zero-width and bidi overrides.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export const INJECTION_PATTERNS = Object.freeze([
  { id: "ignore_instructions", re: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|preceding|system)\s+(instructions|prompts?|rules|directions)\b/gi },
  { id: "role_marker", re: /(^|[\s\[(>"'])(system|assistant|developer)\s*:/gim },
  { id: "instruction_tag", re: /<\s*\/?\s*(tool|tools|instructions?|system|important|im_start|im_end|prompt|admin)\b[^>]*>/gi },
  { id: "chat_template", re: /<\|(im_start|im_end|system|endoftext)\|>|\[\/?INST\]/gi },
  { id: "new_instructions", re: /\b(new|updated|real)\s+instructions\s*:/gi },
  { id: "tool_steering", re: /\b(you\s+must|you\s+should|immediately)\s+(now\s+)?(call|invoke|run|execute|use)\s+(the\s+)?(tool|function)?/gi },
]);

export const SECRET_PATTERNS = Object.freeze([
  { id: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { id: "github_token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { id: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai_key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "aws_access_key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
]);

export function stripControlChars(text) {
  return String(text).replace(CONTROL_CHARS, "");
}

/** Returns the ids of injection markers present in `text` (no mutation). */
export function detectInjection(text) {
  const found = [];
  for (const { id, re } of INJECTION_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) found.push(id);
    re.lastIndex = 0;
  }
  return found;
}

function neutralizeInjection(text) {
  let out = text;
  for (const { re } of INJECTION_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[neutralized]");
  }
  return out;
}

export function redactSecrets(text) {
  let count = 0;
  let out = String(text);
  for (const { id, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, () => { count += 1; return `[REDACTED:${id}]`; });
  }
  return { text: out, count };
}

function capUtf8(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const buf = Buffer.from(text).subarray(0, maxBytes);
  // Drop a trailing partial code point.
  return { text: buf.toString("utf8").replace(/�$/, ""), truncated: true };
}

/**
 * Description hygiene: descriptions reach a model's context, so they are
 * treated as untrusted data. Returns the sanitized text and any markers found.
 */
export function sanitizeDescription(raw, { maxChars = DEFAULT_LIMITS.maxDescriptionChars } = {}) {
  let text = stripControlChars(typeof raw === "string" ? raw : "").replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const markers = detectInjection(text);
  if (markers.length) text = neutralizeInjection(text);
  text = redactSecrets(text).text;
  let truncated = false;
  if (text.length > maxChars) { text = `${text.slice(0, maxChars - 1)}…`; truncated = true; }
  return { text, markers, flagged: markers.length > 0, truncated };
}

/** Glob with `*` (any run of characters) and `?` (one character). */
export function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function matchesAnyGlob(name, globs) {
  return (globs ?? []).some((glob) => globToRegExp(glob).test(name));
}

function schemaIsObject(schema) {
  return Boolean(schema) && typeof schema === "object" && !Array.isArray(schema) && schema.type === "object"
    && (schema.properties === undefined || (typeof schema.properties === "object" && !Array.isArray(schema.properties)));
}

// ---------------------------------------------------------------------------
// Result sanitization
// ---------------------------------------------------------------------------

function scrubKnown(text, secrets) {
  let out = text;
  let count = 0;
  for (const secret of secrets ?? []) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    if (out.includes(secret)) { count += out.split(secret).length - 1; out = out.split(secret).join("[REDACTED:credential]"); }
  }
  return { text: out, count };
}

function sanitizeStrings(value, state) {
  if (typeof value === "string") {
    const known = scrubKnown(value, state.secrets);
    state.redactions += known.count;
    const clean = stripControlChars(known.text);
    const markers = detectInjection(clean);
    if (markers.length) state.markers.push(...markers);
    const { text, count } = redactSecrets(clean);
    state.redactions += count;
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeStrings(item, state));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[sanitizeStrings(key, state)] = sanitizeStrings(child, state);
    }
    return out;
  }
  return value;
}

export function sanitizeToolResult(result, { serverId, tool, limits = DEFAULT_LIMITS, secrets = [] } = {}) {
  const state = { markers: [], redactions: 0, truncated: false, dropped: [], secrets };
  const content = [];
  let budget = limits.maxResultBytes;
  const items = Array.isArray(result?.content) ? result.content : [];
  if (items.length > limits.maxContentItems) {
    state.dropped.push({ reason: "too_many_items", count: items.length - limits.maxContentItems });
  }
  for (const item of items.slice(0, limits.maxContentItems)) {
    const type = item?.type;
    if (type === "text" && typeof item.text === "string") {
      let text = sanitizeStrings(item.text, state);
      const capped = capUtf8(text, Math.max(0, Math.min(limits.maxTextBytes, budget)));
      if (capped.truncated) state.truncated = true;
      text = capped.text;
      budget -= Buffer.byteLength(text);
      content.push({ type: "text", text });
    } else if (type === "image" && typeof item.data === "string") {
      const mediaType = String(item.mimeType ?? item.mediaType ?? "").toLowerCase();
      const bytes = Math.floor((item.data.length * 3) / 4);
      if (!ALLOWED_IMAGE_TYPES.includes(mediaType)) {
        state.dropped.push({ type, reason: "media_type_not_allowed", mediaType: mediaType.slice(0, 64) });
      } else if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) {
        state.dropped.push({ type, reason: "invalid_base64" });
      } else if (bytes > limits.maxImageBytes || bytes > budget) {
        state.dropped.push({ type, reason: "too_large", bytes });
      } else {
        budget -= item.data.length;
        content.push({ type: "image", mediaType, data: item.data, bytes });
      }
    } else {
      state.dropped.push({ type: typeof type === "string" ? type.slice(0, 32) : "unknown", reason: "content_type_not_allowed" });
    }
  }

  let structuredContent;
  if (result && result.structuredContent !== undefined) {
    const raw = JSON.stringify(result.structuredContent);
    if (raw === undefined || Buffer.byteLength(raw) > Math.min(limits.maxStructuredBytes, Math.max(0, budget))) {
      state.dropped.push({ type: "structuredContent", reason: "too_large" });
    } else {
      structuredContent = sanitizeStrings(JSON.parse(raw), state);
    }
  }

  const markers = [...new Set(state.markers)];
  return {
    untrusted: true,
    serverId,
    tool,
    isError: result?.isError === true,
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    flags: {
      injectionSuspected: markers.length > 0,
      injectionMarkers: markers,
      redactions: state.redactions,
      truncated: state.truncated,
      dropped: state.dropped,
    },
  };
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export class McpGateway {
  /**
   * @param {object} options
   * @param {(ctx: object) => boolean|{allow:boolean, reason?:string}|Promise<...>} options.authorize
   *        Called on EVERY call. Absent → every call is denied (fail closed).
   * @param {(event: object) => void|Promise<void>} [options.audit]
   * @param {() => number} [options.now]
   * @param {object} [options.limits]
   * @param {boolean} [options.blockFlaggedTools] refuse calls to tools whose description was flagged (default true)
   * @param {(tenantId: string, serverId: string, scope: string) => (string|null|{token:string}|Promise<...>)} [options.credentialProvider]
   *        The only source of server credentials. Absent → servers that require a credential are denied.
   * @param {(ms: number) => Promise<void>} [options.sleep] backoff sleeper (tests)
   */
  constructor({ authorize, audit = () => {}, now = () => Date.now(), limits = {}, blockFlaggedTools = true, credentialProvider = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.credentialProvider = typeof credentialProvider === "function" ? credentialProvider : null;
    this.sleep = sleep;
    this.authorize = typeof authorize === "function" ? authorize : () => ({ allow: false, reason: "no_authorizer_configured" });
    this.auditSink = audit;
    this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.blockFlaggedTools = blockFlaggedTools;
    this.servers = new Map();
    this.rateLimiter = createRateLimiter({ now });
  }

  static key(tenantId, serverId) {
    return `${tenantId}\u0000${serverId}`;
  }

  registerServer({
    tenantId,
    serverId,
    transportFactory,
    credentialsScope = null,
    allowedTools = [],
    rateLimit = { perMinute: 60 },
    timeoutMs = 30_000,
    connectTimeoutMs = 30_000,
    trust = "untrusted",
    risk = "moderate",
    clientInfo = undefined,
    http = undefined,
    requiresCredential = undefined,
    reconnectBackoffMs = 250,
  }) {
    if (typeof tenantId !== "string" || !tenantId) throw new McpGatewayError("INVALID_REGISTRATION", "tenantId is required.");
    if (typeof serverId !== "string" || !SERVER_ID.test(serverId)) {
      throw new McpGatewayError("INVALID_REGISTRATION", "serverId must match /^[a-z][a-z0-9_-]{0,63}$/.");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new McpGatewayError("INVALID_REGISTRATION", "timeoutMs must be a positive integer.");
    if (http !== undefined) {
      if (transportFactory !== undefined) throw new McpGatewayError("INVALID_REGISTRATION", "Pass either transportFactory or http, not both.");
      if (!http || typeof http.url !== "string") throw new McpGatewayError("INVALID_REGISTRATION", "http.url is required.");
      const { url, allowLoopback = false, allowPrivateHosts = [], maxResponseBytes, lookup, headers } = http;
      try { createStreamableHttpTransport({ url, allowLoopback, allowPrivateHosts }); } catch (error) {
        throw new McpGatewayError(error.code === "SSRF_BLOCKED" ? "SSRF_BLOCKED" : "INVALID_REGISTRATION", error.message);
      }
      transportFactory = ({ getCredential }) => createStreamableHttpTransport({
        url, allowLoopback, allowPrivateHosts, timeoutMs: Math.max(timeoutMs, connectTimeoutMs),
        ...(lookup ? { lookup } : {}),
        ...(headers ? { headers } : {}),
        ...(maxResponseBytes ? { maxResponseBytes } : {}),
        ...(credentialsScope ? { getToken: getCredential } : {}),
      });
    }
    if (typeof transportFactory !== "function") throw new McpGatewayError("INVALID_REGISTRATION", "transportFactory is required.");
    if (credentialsScope !== null && (typeof credentialsScope !== "string" || !credentialsScope)) {
      throw new McpGatewayError("INVALID_REGISTRATION", "credentialsScope must be a non-empty string or null.");
    }
    const needsCredential = requiresCredential ?? (http !== undefined && credentialsScope !== null);
    if (needsCredential && !credentialsScope) throw new McpGatewayError("INVALID_REGISTRATION", "A server that requires a credential needs a credentialsScope.");
    if (!Number.isInteger(reconnectBackoffMs) || reconnectBackoffMs < 0) throw new McpGatewayError("INVALID_REGISTRATION", "reconnectBackoffMs must be a non-negative integer.");
    if (!Array.isArray(allowedTools) || !allowedTools.every((g) => typeof g === "string" && g)) {
      throw new McpGatewayError("INVALID_REGISTRATION", "allowedTools must be a list of glob strings.");
    }
    if (!["untrusted", "reviewed"].includes(trust)) throw new McpGatewayError("INVALID_REGISTRATION", "trust must be 'untrusted' or 'reviewed'.");
    if (!RISK_LEVELS.includes(risk)) throw new McpGatewayError("INVALID_REGISTRATION", `Unknown risk '${risk}'.`);
    const perMinute = rateLimit?.perMinute;
    if (!Number.isInteger(perMinute) || perMinute < 1) throw new McpGatewayError("INVALID_REGISTRATION", "rateLimit.perMinute must be a positive integer.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new McpGatewayError("INVALID_REGISTRATION", "timeoutMs must be a positive integer.");
    if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1) throw new McpGatewayError("INVALID_REGISTRATION", "connectTimeoutMs must be a positive integer.");
    const key = McpGateway.key(tenantId, serverId);
    if (this.servers.has(key)) throw new McpGatewayError("DUPLICATE_SERVER", `Server '${serverId}' is already registered for this tenant.`);
    this.servers.set(key, {
      tenantId, serverId, transportFactory, credentialsScope, allowedTools: [...allowedTools],
      perMinute, timeoutMs, connectTimeoutMs, trust, risk, clientInfo, requiresCredential: needsCredential, reconnectBackoffMs,
      transport: http ? "http" : "custom",
      client: null, connecting: null, everConnected: false, tools: null, flagged: [], rejected: [],
      secrets: new Set(),
    });
    return { tenantId, serverId };
  }

  #lookup(tenantId, serverId) {
    const entry = typeof tenantId === "string" ? this.servers.get(McpGateway.key(tenantId, serverId)) : undefined;
    // Same error whether the server does not exist or belongs to another
    // tenant, so tenants cannot probe each other's registrations.
    if (!entry) throw new McpGatewayError("SERVER_NOT_FOUND", `No MCP server '${serverId}' for this tenant.`);
    return entry;
  }

  /**
   * Resolves the registration's credential through the provider. Always keyed
   * by the registration (tenant, server, scope) — callers cannot choose them.
   * Throws CREDENTIAL_UNAVAILABLE; the value is remembered only to scrub it.
   */
  async #resolveCredential(entry) {
    const unavailable = () => new McpGatewayError("CREDENTIAL_UNAVAILABLE", `No credential is available for server '${entry.serverId}'.`);
    if (!entry.credentialsScope || !this.credentialProvider) throw unavailable();
    let value;
    try {
      value = await this.credentialProvider(entry.tenantId, entry.serverId, entry.credentialsScope);
    } catch {
      throw unavailable();
    }
    const token = typeof value === "string" ? value : (value && typeof value === "object" && typeof value.token === "string" ? value.token : null);
    if (!token) throw unavailable();
    entry.secrets.add(token);
    return token;
  }

  #scrub(entry, text) {
    return redactSecrets(scrubKnown(String(text ?? ""), entry?.secrets).text).text;
  }

  async #connect(entry) {
    if (entry.client && !entry.client.closed) return entry.client;
    if (!entry.connecting) {
      entry.connecting = (async () => {
        const getCredential = () => this.#resolveCredential(entry);
        const transport = await entry.transportFactory({ tenantId: entry.tenantId, serverId: entry.serverId, credentialsScope: entry.credentialsScope, getCredential });
        const client = new McpClient({ transport, requestTimeoutMs: entry.connectTimeoutMs, ...(entry.clientInfo ? { clientInfo: entry.clientInfo } : {}) });
        try {
          await client.initialize();
        } catch (error) {
          await client.close().catch(() => {});
          throw error;
        }
        entry.client = client;
        entry.everConnected = true;
        return client;
      })().finally(() => { entry.connecting = null; });
    }
    return entry.connecting;
  }

  /**
   * Runs `fn(client)`, re-creating a dead client at most once for this call:
   * either because the previous client had died (after a backoff), or because
   * the call failed with an error proving it was never delivered.
   */
  async #withClient(entry, fn) {
    let recreated = false;
    const reconnect = async () => {
      recreated = true;
      const old = entry.client;
      entry.client = null;
      if (old) await old.close().catch(() => {});
      if (entry.reconnectBackoffMs > 0) await this.sleep(entry.reconnectBackoffMs);
      return this.#connect(entry);
    };
    const dead = entry.everConnected && (!entry.client || entry.client.closed) && !entry.connecting;
    const client = dead ? await reconnect() : await this.#connect(entry);
    try {
      return await fn(client);
    } catch (error) {
      const undelivered = error?.retryable === true || error?.code === "TRANSPORT_CLOSED" || error?.code === "SESSION_EXPIRED";
      if (recreated || !undelivered || error instanceof McpGatewayError) throw error;
      return fn(await reconnect());
    }
  }

  async #audit(event) {
    await this.auditSink({ at: new Date(this.now()).toISOString(), ...event });
  }

  /**
   * Connects (if needed), lists tools and records the sanitized catalog.
   * @param {string} serverId
   * @param {{tenantId: string, userId?: string}} ctx
   */
  async discover(serverId, ctx = {}) {
    const started = this.now();
    const base = { type: "mcp.discover", tenantId: ctx.tenantId ?? null, userId: ctx.userId ?? null, serverId, tool: null, argsDigest: null };
    let entry;
    try {
      entry = this.#lookup(ctx.tenantId, serverId);
    } catch (error) {
      await this.#audit({ ...base, outcome: "denied", reason: error.code, durationMs: this.now() - started });
      throw error;
    }
    if (entry.requiresCredential) {
      try { await this.#resolveCredential(entry); } catch (error) {
        await this.#audit({ ...base, outcome: "denied", reason: error.code, durationMs: this.now() - started });
        throw error;
      }
    }
    try {
      const rawTools = await this.#withClient(entry, (client) => client.listTools({ timeoutMs: entry.connectTimeoutMs }));
      const tools = new Map();
      const flagged = [];
      const rejected = [];
      for (const raw of rawTools.slice(0, this.limits.maxTools)) {
        const name = raw?.name;
        if (typeof name !== "string" || !TOOL_NAME.test(name)) {
          rejected.push({ name: typeof name === "string" ? stripControlChars(name).slice(0, 64) : null, reason: "invalid_name" });
          continue;
        }
        if (tools.has(name)) { rejected.push({ name, reason: "duplicate_name" }); continue; }
        if (!schemaIsObject(raw.inputSchema)) { rejected.push({ name, reason: "input_schema_not_object" }); continue; }
        const description = sanitizeDescription(raw.description, { maxChars: this.limits.maxDescriptionChars });
        const title = typeof raw.title === "string" ? sanitizeDescription(raw.title, { maxChars: 128 }) : null;
        const markers = [...new Set([...description.markers, ...(title?.markers ?? [])])];
        const inputSchema = JSON.parse(JSON.stringify(raw.inputSchema));
        const tool = Object.freeze({
          name,
          title: title?.text ?? null,
          description: description.text || `MCP tool '${name}'`,
          inputSchema,
          flagged: markers.length > 0,
          injectionMarkers: markers,
          allowed: matchesAnyGlob(name, entry.allowedTools),
          annotations: raw.annotations && typeof raw.annotations === "object" ? sanitizeStrings(raw.annotations, { markers: [], redactions: 0 }) : null,
        });
        if (tool.flagged) flagged.push({ name, markers });
        tools.set(name, tool);
      }
      if (rawTools.length > this.limits.maxTools) rejected.push({ name: null, reason: "too_many_tools", count: rawTools.length - this.limits.maxTools });
      entry.tools = tools;
      entry.flagged = flagged;
      entry.rejected = rejected;
      await this.#audit({ ...base, outcome: "success", toolCount: tools.size, flaggedTools: flagged.map((f) => f.name), rejectedTools: rejected, durationMs: this.now() - started });
      return this.listTools(serverId, ctx);
    } catch (error) {
      const message = this.#scrub(entry, error.message).slice(0, 300);
      await this.#audit({ ...base, outcome: "error", reason: error.code ?? "ERROR", message, durationMs: this.now() - started });
      if (error instanceof McpGatewayError) throw error;
      throw new McpGatewayError(typeof error.code === "string" ? error.code : "DISCOVER_FAILED", message);
    }
  }

  /** The sanitized catalog from the last discover (all tools, with `allowed` / `flagged`). */
  listTools(serverId, ctx = {}) {
    const entry = this.#lookup(ctx.tenantId, serverId);
    if (!entry.tools) return [];
    return [...entry.tools.values()];
  }

  flaggedTools(serverId, ctx = {}) {
    return [...this.#lookup(ctx.tenantId, serverId).flagged];
  }

  rejectedTools(serverId, ctx = {}) {
    return [...this.#lookup(ctx.tenantId, serverId).rejected];
  }

  serverInfo(serverId, ctx = {}) {
    const entry = this.#lookup(ctx.tenantId, serverId);
    return { tenantId: entry.tenantId, serverId: entry.serverId, trust: entry.trust, risk: entry.risk, allowedTools: [...entry.allowedTools], credentialsScope: entry.credentialsScope, requiresCredential: entry.requiresCredential, transport: entry.transport };
  }

  /**
   * Authorizes, validates, rate-limits, sends, sanitizes and audits one call.
   * @param {{tenantId: string, userId?: string, agentId?: string, taskId?: string}} ctx
   */
  async callTool(ctx, serverId, toolName, args = {}) {
    const started = this.now();
    let argsDigest = null;
    try { argsDigest = digest(args ?? {}); } catch { argsDigest = null; }
    const base = {
      type: "mcp.call",
      tenantId: ctx?.tenantId ?? null,
      userId: ctx?.userId ?? null,
      agentId: ctx?.agentId ?? null,
      taskId: ctx?.taskId ?? null,
      serverId,
      tool: typeof toolName === "string" ? toolName.slice(0, 128) : null,
      argsDigest,
    };
    const deny = async (code, message, details) => {
      await this.#audit({ ...base, outcome: "denied", reason: code, durationMs: this.now() - started });
      throw new McpGatewayError(code, message, details);
    };

    let entry;
    try { entry = this.#lookup(ctx?.tenantId, serverId); } catch (error) { return deny(error.code, error.message); }
    if (typeof toolName !== "string" || !TOOL_NAME.test(toolName)) return deny("INVALID_TOOL_NAME", "Invalid MCP tool name.");
    if (!matchesAnyGlob(toolName, entry.allowedTools)) {
      return deny("TOOL_NOT_ALLOWED", `Tool '${toolName}' is not in the allowed list for server '${serverId}'.`);
    }
    if (!entry.tools) return deny("NOT_DISCOVERED", `Server '${serverId}' has not been discovered yet.`);
    const tool = entry.tools.get(toolName);
    if (!tool) return deny("UNKNOWN_TOOL", `Server '${serverId}' does not expose '${toolName}'.`);
    if (tool.flagged && this.blockFlaggedTools && entry.trust === "untrusted") {
      return deny("TOOL_FLAGGED", `Tool '${toolName}' was flagged for a suspicious description and the server is untrusted.`, { markers: tool.injectionMarkers });
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return deny("INVALID_ARGUMENTS", "Arguments must be an object.");
    const schemaErrors = validateSchema(tool.inputSchema, args);
    if (schemaErrors.length) {
      return deny("INVALID_ARGUMENTS", `Arguments are invalid: ${schemaErrors.map((e) => `${e.path} ${e.message}`).join("; ")}.`, schemaErrors);
    }

    let decision;
    try {
      decision = await this.authorize({
        tenantId: ctx.tenantId, userId: ctx.userId ?? null, agentId: ctx.agentId ?? null, taskId: ctx.taskId ?? null,
        serverId, tool: toolName, argsDigest, risk: entry.risk, trust: entry.trust, credentialsScope: entry.credentialsScope,
        context: ctx,
      });
    } catch (error) {
      return deny("AUTHORIZATION_ERROR", `Authorization failed: ${String(error.message).slice(0, 200)}`);
    }
    const allowed = decision === true || (decision && typeof decision === "object" && decision.allow === true);
    if (!allowed) {
      const reason = decision && typeof decision === "object" && decision.reason ? String(decision.reason).slice(0, 200) : "denied by authorizer";
      return deny("UNAUTHORIZED", `Call to '${toolName}' was not authorized: ${reason}.`);
    }

    const rate = this.rateLimiter.check({ bucket: "mcp", client: McpGateway.key(entry.tenantId, serverId), limit: entry.perMinute, windowMs: 60_000 });
    if (!rate.allowed) {
      return deny("RATE_LIMITED", `Rate limit for '${serverId}' exceeded; retry after ${rate.retryAfterSeconds}s.`, { retryAfterSeconds: rate.retryAfterSeconds });
    }

    if (entry.requiresCredential) {
      try { await this.#resolveCredential(entry); } catch (error) { return deny(error.code, error.message); }
    }

    try {
      const raw = await this.#withClient(entry, (client) => client.callTool(toolName, args, { timeoutMs: entry.timeoutMs }));
      const output = sanitizeToolResult(raw, { serverId, tool: toolName, limits: this.limits, secrets: [...entry.secrets] });
      await this.#audit({
        ...base, outcome: "success", isError: output.isError, durationMs: this.now() - started,
        injectionSuspected: output.flags.injectionSuspected, injectionMarkers: output.flags.injectionMarkers,
        redactions: output.flags.redactions, outputDigest: digest(output),
      });
      return output;
    } catch (error) {
      if (error instanceof McpGatewayError) throw error;
      const message = this.#scrub(entry, error.message).slice(0, 300);
      await this.#audit({ ...base, outcome: "error", reason: error.code ?? "ERROR", message, durationMs: this.now() - started });
      throw new McpGatewayError(error.code === "TIMEOUT" ? "TIMEOUT" : "CALL_FAILED", message, { cause: typeof error.code === "string" ? error.code : "ERROR" });
    }
  }

  async close() {
    await Promise.all([...this.servers.values()].map(async (entry) => {
      const client = entry.client;
      entry.client = null;
      if (client) await client.close().catch(() => {});
    }));
  }
}
