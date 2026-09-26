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
  return (capability, _risk, tool, input, context = {}) => {
    const configured = policyForCapability(capability)?.decision ?? "deny";
    const toolName = String(tool?.name ?? "unknown");
    const validDecision = ["allow", "ask", "deny"].includes(configured) ? configured : "deny";
    const rules = validDecision === "deny"
      ? [{ id: "operator-deny", tool: toolName, effect: "deny", reason: "The operator denied this capability." }]
      : validDecision === "ask"
        ? [{ id: "operator-approval", tool: toolName, effect: "require_approval", reason: "The operator requires approval for this capability." }]
        : [];
    const engine = new PolicyEngine({ version, rules });
    const record = engine.evaluate({
      tenantId,
      userId,
      agentId: typeof context.agentId === "string" ? context.agentId : null,
      taskId: typeof context.taskId === "string" ? context.taskId : null,
      tool: {
        name: toolName,
        risk: tool?.risk ?? "critical",
        consequential: tool?.requiresApproval === true,
      },
      input: input ?? {},
      grantedPermissions: validDecision === "deny" ? [] : [toolName],
    });
    audit({
      type: "policy.decision",
      tenantId,
      userId,
      agentId: record.agentId,
      taskId: record.taskId,
      tool: record.tool,
      effect: record.effect,
      reasons: record.reasons,
      policyVersion: record.policyVersion,
      decidedAt: record.decidedAt,
    });
    if (record.effect === "deny") return "deny";
    if (record.effect === "require_approval") return "ask";
    return "allow";
  };
}