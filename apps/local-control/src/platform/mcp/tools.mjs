import { defineTool, RISK_LEVELS } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { McpGatewayError } from "./gateway.mjs";

/**
 * Exposes discovered MCP tools as Atlas tool definitions so the platform's
 * AuthorizedToolExecutor can run them through the normal policy / budget /
 * approval path. Only tools that are allowed (allowedTools glob) and not
 * blocked for a flagged description are exposed. Execution still goes through
 * McpGateway.callTool, which re-checks authorization on every call.
 */

/** Normalizes one name segment to lower_snake_case starting with a letter. */
export function normalizeSegment(raw) {
  let seg = String(raw)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!seg) seg = "tool";
  if (!/^[a-z]/.test(seg)) seg = `t_${seg}`;
  return seg;
}

export function mcpToolName(serverId, toolName) {
  return `mcp.${normalizeSegment(serverId)}.${normalizeSegment(toolName)}`;
}

/**
 * @param {import("./gateway.mjs").McpGateway} gateway
 * @param {object} options
 * @param {string} options.tenantId      owner of the server registration
 * @param {string} options.serverId
 * @param {string} [options.risk]        default risk (falls back to the registration's, then 'moderate')
 * @param {Record<string,string>} [options.riskOverrides]  per MCP tool name
 * @param {Record<string,boolean>|((name:string)=>boolean)} [options.consequential]  per MCP tool name (default false)
 * @param {boolean} [options.includeFlagged] expose flagged tools too (gateway still blocks them for untrusted servers)
 */
export function mcpToolDefinitions(gateway, { tenantId, serverId, risk, riskOverrides = {}, consequential = {}, includeFlagged = false } = {}) {
  const ctx = { tenantId };
  const info = gateway.serverInfo(serverId, ctx);
  const defaultRisk = risk ?? info.risk ?? "moderate";
  const isConsequential = typeof consequential === "function" ? consequential : (name) => Boolean(consequential[name]);
  const seen = new Map();
  const definitions = [];
  for (const tool of gateway.listTools(serverId, ctx)) {
    if (!tool.allowed) continue;
    if (tool.flagged && !includeFlagged) continue;
    const name = mcpToolName(serverId, tool.name);
    if (seen.has(name)) {
      throw new McpGatewayError("TOOL_NAME_COLLISION", `MCP tools '${seen.get(name)}' and '${tool.name}' both normalize to '${name}'.`);
    }
    seen.set(name, tool.name);
    const toolRisk = riskOverrides[tool.name] ?? defaultRisk;
    if (!RISK_LEVELS.includes(toolRisk)) throw new McpGatewayError("INVALID_RISK", `Unknown risk '${toolRisk}' for '${tool.name}'.`);
    const mcpName = tool.name;
    definitions.push(defineTool({
      name,
      description: `[untrusted MCP tool ${serverId}/${mcpName}] ${tool.description}`,
      risk: toolRisk,
      consequential: isConsequential(mcpName),
      inputSchema: tool.inputSchema,
      async execute(input, context = {}) {
        const callerTenant = context.tenantId ?? context.actor?.tenantId;
        if (callerTenant !== tenantId) {
          throw new McpGatewayError("SERVER_NOT_FOUND", `No MCP server '${serverId}' for this tenant.`);
        }
        const output = await gateway.callTool({
          tenantId: callerTenant,
          userId: context.userId ?? context.actor?.userId ?? null,
          agentId: context.agentId ?? context.actor?.agentId ?? null,
          taskId: context.taskId ?? null,
        }, serverId, mcpName, input);
        return {
          output,
          evidence: [{ kind: "mcp_call", serverId, tool: mcpName, untrusted: true, injectionSuspected: output.flags.injectionSuspected }],
        };
      },
    }));
  }
  return definitions;
}
