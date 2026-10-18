import { defineTool } from "../../../../packages/atlas-contracts/src/index.mjs";
import { actionDigest, ToolError, validateAgainstSchema } from "../agent/tool-registry.mjs";
import { registerRepositoryTools } from "../agent/tools/repository-tools.mjs";

/**
 * Bridges tools written for the conversational agent's ToolRegistry into
 * platform ToolDefinitions, so existing, already-confined implementations run
 * behind the authorized executor instead of being rewritten.
 *
 * The legacy `execute({ input, context })` expects defaults filled in by its
 * registry, so the adapter runs the legacy validator (which also applies
 * defaults) after the executor's contract validation. The adapted schema
 * forbids unknown properties, because a dropped argument is a tool doing
 * something other than what was authorized.
 */
export function adaptRegistryTool(legacy, { context = {}, risk = undefined, consequential = false } = {}) {
  const readOnly = typeof legacy.capability === "string" && legacy.capability.endsWith(".read");
  const tool = defineTool({
    name: legacy.name,
    description: legacy.description,
    risk: risk ?? (readOnly ? "read" : legacy.risk),
    consequential: consequential || legacy.requiresApproval === true,
    inputSchema: { ...legacy.inputSchema, additionalProperties: false },
    async execute(input, runtimeContext) {
      const prepared = validateAgainstSchema(legacy.inputSchema, input);
      const request = { input: prepared, context: { ...context, ...runtimeContext, signal: runtimeContext.signal }, signal: runtimeContext.signal,
        digest: actionDigest({ sessionId: runtimeContext.taskId, tool: legacy.name, input: prepared }) };
      if ((legacy.credentials?.length ?? 0) > 0 && typeof legacy.executeAuthorized !== "function") throw new ToolError("MISSING_CREDENTIAL", "This tool needs the registered credential resolver.");
      const output = await (legacy.executeAuthorized ?? legacy.execute)(request);
      return { output, evidence: [{ kind: "legacy_tool", tool: legacy.name, capability: legacy.capability ?? null }] };
    },
  });
  return { tool, timeoutMs: legacy.timeoutMs };
}

/** The read-only repository tools (list/read/search), confined to `repository`. */
export function repositoryPlatformTools({ repository }) {
  const captured = [];
  registerRepositoryTools({ register: (definition) => captured.push(definition) });
  return captured.map((legacy) => adaptRegistryTool(legacy, { context: { repository } }));
}
