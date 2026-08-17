export const TOOL_CAPABILITIES = [
  "read",
  "write",
  "execute",
  "network",
  "credential",
  "external",
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];
export const TOOL_RISK_LEVELS = ["low", "moderate", "high", "critical"] as const;
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];
export type PolicyDecision = "allow" | "ask" | "deny";

export type ToolScope =
  | { readonly kind: "global" }
  | { readonly kind: "repository"; readonly repositoryId: string }
  | {
      readonly kind: "path";
      readonly repositoryId: string;
      readonly path: string;
    };

export interface ToolPolicyRequest {
  readonly capability: ToolCapability;
  readonly risk: ToolRiskLevel;
  readonly scope: ToolScope;
}

export interface ToolPolicyRule {
  readonly id: string;
  readonly capabilities: readonly ToolCapability[];
  /** Omit to match every classified risk level. */
  readonly risks?: readonly ToolRiskLevel[];
  readonly scope: ToolScope;
  readonly decision: PolicyDecision;
  readonly description?: string;
}

export interface ToolPolicy {
  readonly defaultDecision: PolicyDecision;
  readonly rules: readonly ToolPolicyRule[];
}

export interface ToolPolicyEvaluation {
  readonly decision: PolicyDecision;
  readonly matchedRuleIds: readonly string[];
  readonly usedDefault: boolean;
}

const DECISION_PRECEDENCE: Readonly<Record<PolicyDecision, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * Evaluates declarative policy only. This function grants no capability and
 * performs no tool action. Callers must enforce the returned decision.
 */
export function evaluateToolPolicy(
  policy: ToolPolicy,
  request: ToolPolicyRequest,
): ToolPolicyEvaluation {
  validatePolicy(policy);
  validateScope(request.scope, "request");

  const matchingRules = policy.rules.filter(
    (rule) =>
      rule.capabilities.includes(request.capability) &&
      (rule.risks === undefined || rule.risks.includes(request.risk)) &&
      scopeMatches(rule.scope, request.scope),
  );

  if (matchingRules.length === 0) {
    return {
      decision: policy.defaultDecision,
      matchedRuleIds: [],
      usedDefault: true,
    };
  }

  let decision: PolicyDecision = "allow";
  for (const rule of matchingRules) {
    if (DECISION_PRECEDENCE[rule.decision] > DECISION_PRECEDENCE[decision]) {
      decision = rule.decision;
    }
  }

  return {
    decision,
    matchedRuleIds: matchingRules.map((rule) => rule.id),
    usedDefault: false,
  };
}

function scopeMatches(rule: ToolScope, request: ToolScope): boolean {
  if (rule.kind === "global") {
    return true;
  }

  if (request.kind === "global" || rule.repositoryId !== request.repositoryId) {
    return false;
  }

  if (rule.kind === "repository") {
    return true;
  }

  if (request.kind !== "path") {
    return false;
  }

  const rulePath = normalizeRelativePath(rule.path);
  const requestPath = normalizeRelativePath(request.path);
  return requestPath === rulePath || requestPath.startsWith(`${rulePath}/`);
}

function validatePolicy(policy: ToolPolicy): void {
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (rule.id.trim().length === 0) {
      throw new Error("Tool policy rule IDs must not be empty.");
    }
    if (ids.has(rule.id)) {
      throw new Error(`Duplicate tool policy rule ID: ${rule.id}`);
    }
    ids.add(rule.id);
    if (rule.capabilities.length === 0) {
      throw new Error(`Tool policy rule ${rule.id} must name a capability.`);
    }
    if (rule.risks !== undefined && rule.risks.length === 0) {
      throw new Error(`Tool policy rule ${rule.id} must name a risk when risks are specified.`);
    }
    validateScope(rule.scope, `rule ${rule.id}`);
  }
}

function validateScope(scope: ToolScope, owner: string): void {
  if (scope.kind !== "global" && scope.repositoryId.trim().length === 0) {
    throw new Error(`Tool policy ${owner} repository ID must not be empty.`);
  }
  if (scope.kind === "path") {
    normalizeRelativePath(scope.path);
  }
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Tool policy paths must be normalized repository-relative paths: ${path}`);
  }
  return normalized;
}
