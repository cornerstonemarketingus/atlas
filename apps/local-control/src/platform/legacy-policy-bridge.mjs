import { PolicyEngine } from "./policy.mjs";

/**
 * Transitional adapter: makes the deterministic platform PolicyEngine the
 * decision core for the existing local ToolRegistry while preserving the
 * current operator allow/ask/deny settings and digest-bound approval store.
 * Audit receives decision metadata only; validated tool inputs are never sent
 * to the audit callback.
 */
export function createLegacyPolicyBridge({ policyForCapability, audit = () => {}, tenantId = "local", userId = "local-owner", version = "local-policy-bridge.v1" }) {
  if (typeof policyForCapability !== "function") throw new TypeError("policyForCapability is required.");
  const engine = createLegacyPolicyEngine({ policyForCapability, audit, tenantId, userId, version });
  return (capability, _risk, tool, input, context = {}) => {
    const record = engine.evaluate({
      tenantId: context.tenantId ?? tenantId,
      userId: context.userId ?? userId,
      agentId: context.agentId ?? null,
      taskId: context.taskId ?? null,
      tool: { ...tool, capability },
      input,
      grantedPermissions: [tool.name],
      correlationId: context.correlationId ?? null,
      toolCallId: context.toolCallId ?? null,
    });
    if (record.effect === "deny") return "deny";
    if (record.effect === "require_approval") return "ask";
    return "allow";
  };
}

/** Full-decision adapter for callers that use the durable platform executor. */
export function createLegacyPolicyEngine({ policyForCapability, audit = () => {}, tenantId = "local", userId = "local-owner", version = "local-policy-bridge.v1", capabilityForTool = (name) => name }) {
  if (typeof policyForCapability !== "function") throw new TypeError("policyForCapability is required.");
  return {
    version,
    evaluate({ tenantId: requestTenant = tenantId, userId: requestUser = userId, agentId = null, taskId = null, tool, input = {}, grantedPermissions = [], approval = null, correlationId = null, toolCallId = null }) {
      const capability = tool.capability ?? capabilityForTool(tool.name);
      const configured = policyForCapability(capability)?.decision ?? "deny";
      const validDecision = ["allow", "ask", "deny"].includes(configured) ? configured : "deny";
      const rules = validDecision === "deny"
        ? [{ id: "operator-deny", tool: tool.name, effect: "deny", reason: "The operator denied this capability." }]
        : validDecision === "ask"
          ? [{ id: "operator-approval", tool: tool.name, effect: "require_approval", reason: "The operator requires approval for this capability." }]
          : [];
      const policy = new PolicyEngine({ version, rules });
      const record = policy.evaluate({ tenantId: requestTenant, userId: requestUser, agentId, taskId, tool, input, grantedPermissions, approval });
      audit({
        type: "policy.decision", tenantId: requestTenant, userId: requestUser, agentId, taskId, toolCallId, correlationId,
        tool: record.tool, effect: record.effect, reasons: record.reasons, policyVersion: record.policyVersion, decidedAt: record.decidedAt, decision: record,
      });
      return record;
    },
  };
}