import { digest, validateSchema } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { MCP_PROTOCOL_VERSION } from "../mcp/jsonrpc-stdio.mjs";
import { atlasMcpTools } from "./tools.mjs";

/**
 * Transport-independent Atlas MCP server core (blueprint §8).
 *
 * `handle(message, principal)` takes one JSON-RPC message and the principal
 * the transport authenticated (stdio: fixed at launch; HTTP: resolved from
 * the bearer token) and returns the response message, or `undefined` for a
 * notification. The principal is never read from the message itself.
 *
 * Every tools/call: input validated against the tool schema → PolicyEngine
 * decision (only `allow` proceeds; `require_approval` is a denial here since
 * MCP has no approval channel) → execute tenant-scoped → structured output
 * validated against the tool's outputSchema → audit event (args digest only).
 */

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([MCP_PROTOCOL_VERSION, "2025-03-26"]);

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const toolError = (code, text) => ({ isError: true, content: [{ type: "text", text }], structuredContent: { error: { code, message: text } } });

function validPrincipal(p) {
  return Boolean(p) && typeof p.tenantId === "string" && p.tenantId.length > 0 && typeof p.userId === "string" && p.userId.length > 0;
}

export class AtlasMcpServer {
  /**
   * @param {object} options
   * @param {import("../task-store.mjs").PlatformTaskStore} options.store
   * @param {import("../policy.mjs").PolicyEngine} options.policy
   * @param {(event: object) => void} [options.audit]
   * @param {() => Date} [options.clock]
   * @param {object} [options.serverInfo]
   */
  constructor({ store, policy, audit = () => {}, clock = () => new Date(), serverInfo = { name: "atlas", version: "0.1.0" } } = {}) {
    if (!store) throw new Error("AtlasMcpServer needs a task store.");
    if (!policy || typeof policy.evaluate !== "function") throw new Error("AtlasMcpServer needs a PolicyEngine.");
    this.store = store;
    this.policy = policy;
    this.auditSink = audit;
    this.clock = clock;
    this.serverInfo = serverInfo;
    this.tools = new Map(atlasMcpTools(store).map((tool) => [tool.name, tool]));
  }

  #audit(event) {
    try { this.auditSink({ at: this.clock().toISOString(), type: "atlas_mcp.call", ...event }); } catch { /* audit sinks never break calls */ }
  }

  listToolDescriptors() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: { readOnlyHint: tool.risk === "read", destructiveHint: false, idempotentHint: tool.risk === "read", openWorldHint: false },
    }));
  }

  /**
   * One authorized, validated, audited tool invocation. Returns an MCP
   * CallToolResult (tool-level failures are `isError: true`, never thrown).
   */
  async callTool(principal, name, args) {
    const started = Date.now();
    let argsDigest = null;
    try { argsDigest = digest(args ?? {}); } catch { /* unhashable */ }
    const base = {
      tenantId: principal?.tenantId ?? null,
      userId: principal?.userId ?? null,
      agentId: principal?.agentId ?? null,
      tool: typeof name === "string" ? name.slice(0, 128) : null,
      argsDigest,
    };
    const finish = (outcome, result, extra = {}) => {
      this.#audit({ ...base, outcome, durationMs: Date.now() - started, ...extra });
      return result;
    };

    if (!validPrincipal(principal)) return finish("denied", toolError("UNAUTHENTICATED", "No authenticated principal."), { reason: "UNAUTHENTICATED" });
    const tool = typeof name === "string" ? this.tools.get(name) : undefined;
    if (!tool) return finish("denied", toolError("UNKNOWN_TOOL", "Unknown tool."), { reason: "UNKNOWN_TOOL" });
    if (!args || typeof args !== "object" || Array.isArray(args)) return finish("denied", toolError("INVALID_ARGUMENTS", "Arguments must be an object."), { reason: "INVALID_ARGUMENTS" });
    const inputErrors = validateSchema(tool.inputSchema, args);
    if (inputErrors.length) {
      return finish("denied", toolError("INVALID_ARGUMENTS", `Invalid arguments: ${inputErrors.map((e) => `${e.path} ${e.message}`).join("; ")}.`.slice(0, 500)), { reason: "INVALID_ARGUMENTS" });
    }

    let decision;
    try {
      decision = this.policy.evaluate({
        tenantId: principal.tenantId,
        userId: principal.userId,
        agentId: principal.agentId ?? null,
        tool,
        input: args,
        grantedPermissions: Array.isArray(principal.grantedPermissions) ? principal.grantedPermissions : [],
      });
    } catch {
      return finish("denied", toolError("UNAUTHORIZED", "Authorization failed."), { reason: "AUTHORIZATION_ERROR" });
    }
    const policyFields = { policyDecisionId: decision.id, policyVersion: decision.policyVersion, effect: decision.effect };
    if (decision.effect !== "allow") {
      return finish("denied", toolError("UNAUTHORIZED", `Not authorized: ${decision.effect === "require_approval" ? "this action requires approval, which is not available over MCP" : "denied by policy"}.`), { reason: "UNAUTHORIZED", ...policyFields });
    }

    let output;
    try {
      ({ output } = await tool.execute(args, { principal }));
    } catch (error) {
      if (error?.code === "NOT_FOUND") return finish("error", toolError("NOT_FOUND", "Not found."), { reason: "NOT_FOUND", ...policyFields });
      return finish("error", toolError("TOOL_FAILED", "The tool failed."), { reason: typeof error?.code === "string" ? error.code : "TOOL_FAILED", ...policyFields });
    }
    const outputErrors = validateSchema(tool.outputSchema, output);
    if (outputErrors.length) return finish("error", toolError("INVALID_OUTPUT", "The tool produced an invalid result."), { reason: "INVALID_OUTPUT", ...policyFields });
    const result = { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
    return finish("success", result, { outputDigest: digest(output), ...policyFields });
  }

  /** @returns {Promise<object|undefined>} */
  async handle(message, principal) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message?.id, -32600, "Invalid Request");
    }
    if (!("id" in message)) return undefined; // notifications need no answer
    const { id, method, params } = message;
    if (typeof id !== "string" && typeof id !== "number") return rpcError(null, -32600, "Invalid Request");
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.serverInfo,
          instructions: "Atlas task tools. Tasks created here are only proposed; they cannot be authorized or run over MCP.",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: this.listToolDescriptors() });
      case "tools/call": {
        if (!params || typeof params !== "object" || typeof params.name !== "string") return rpcError(id, -32602, "Invalid params");
        try {
          return rpcResult(id, await this.callTool(principal, params.name, params.arguments ?? {}));
        } catch {
          return rpcError(id, -32603, "Internal error");
        }
      }
      default:
        return rpcError(id, -32601, "Method not found");
    }
  }
}
