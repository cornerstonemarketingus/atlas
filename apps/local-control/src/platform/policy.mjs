import {
  POLICY_EFFECTS,
  SCHEMA_VERSION,
  assertSchema,
  newId,
  policyDecisionSchema,
} from "../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Deterministic authorization (policy-as-code).
 *
 * The engine is a pure function of a versioned policy document and the
 * request: no clock-dependent logic, no I/O, no model output. The same input
 * always yields the same effect and reasons, which is what lets a decision be
 * replayed and audited later against the policy version it names.
 *
 * Evaluation order, each step able to end it:
 *   1. malformed request                   -> deny
 *   2. a matching explicit `deny` rule      -> deny (deny always wins)
 *   3. a violated argument constraint       -> deny
 *   4. no granted permission covers the tool -> deny (default deny)
 *   5. consequential / high / critical tool, or a `require_approval` rule
 *      -> require_approval, unless the caller already holds an approval the
 *         executor verified for this exact action
 *   6. allow
 *
 * An agent's `role` is a label for humans and routing. It is never read
 * here: only explicitly granted permission strings authorize a tool, so
 * renaming an agent "admin" changes nothing about what it may do.
 */
export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

const APPROVAL_RISKS = new Set(["high", "critical"]);
const RULE_EFFECTS = new Set(POLICY_EFFECTS);

/**
 * Glob over dotted segments: `*` matches exactly one segment, `**` matches
 * one or more. "browser.*" covers "browser.navigate" but not
 * "browser.tab.open"; "browser.**" covers both; "*" alone covers nothing
 * dotted, so a stray wildcard cannot silently grant every tool.
 */
export function matchesPermission(pattern, name) {
  if (typeof pattern !== "string" || typeof name !== "string" || !pattern || !name) return false;
  const want = pattern.split(".");
  const have = name.split(".");
  const walk = (i, j) => {
    if (i === want.length) return j === have.length;
    if (want[i] === "**") {
      for (let k = j + 1; k <= have.length; k += 1) if (walk(i + 1, k)) return true;
      return false;
    }
    if (j >= have.length) return false;
    return (want[i] === "*" || want[i] === have[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

function ruleTools(rule) {
  if (Array.isArray(rule.tools)) return rule.tools;
  if (typeof rule.tool === "string") return [rule.tool];
  return [];
}

function ruleApplies(rule, request) {
  if (!ruleTools(rule).some((pattern) => matchesPermission(pattern, request.tool.name))) return false;
  if (Array.isArray(rule.tenants) && !rule.tenants.includes(request.tenantId)) return false;
  if (Array.isArray(rule.agents) && !rule.agents.includes(request.agentId)) return false;
  return true;
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Returns a reason string when an argument constraint is violated, else null. */
function constraintViolation(rule, input) {
  if (Array.isArray(rule.allowOrigins)) {
    const field = rule.argument ?? "url";
    const origin = normalizeOrigin(input?.[field]);
    const allowed = rule.allowOrigins.map(normalizeOrigin).filter(Boolean);
    if (!origin || !allowed.includes(origin)) {
      return `rule '${rule.id}': argument '${field}' origin ${origin ?? "(unparseable)"} is not in the allowed origins`;
    }
  }
  if (Array.isArray(rule.denyArgumentPatterns)) {
    for (const { argument, pattern } of rule.denyArgumentPatterns) {
      const value = input?.[argument];
      if (typeof value === "string" && new RegExp(pattern, "u").test(value)) {
        return `rule '${rule.id}': argument '${argument}' matches a denied pattern`;
      }
    }
  }
  return null;
}

function validatePolicyDocument(document) {
  if (!document || typeof document !== "object") throw new PolicyError("INVALID_POLICY", "A policy document is required.");
  if (typeof document.version !== "string" || !document.version) throw new PolicyError("INVALID_POLICY", "A policy document needs a version string.");
  if (!Array.isArray(document.rules)) throw new PolicyError("INVALID_POLICY", "A policy document needs a rules array.");
  const ids = new Set();
  for (const rule of document.rules) {
    if (!rule || typeof rule.id !== "string" || !rule.id) throw new PolicyError("INVALID_POLICY", "Every policy rule needs an id.");
    if (ids.has(rule.id)) throw new PolicyError("INVALID_POLICY", `Duplicate policy rule id '${rule.id}'.`);
    ids.add(rule.id);
    if (ruleTools(rule).length === 0) throw new PolicyError("INVALID_POLICY", `Rule '${rule.id}' must name a tool or tools.`);
    const isConstraint = Array.isArray(rule.allowOrigins) || Array.isArray(rule.denyArgumentPatterns);
    if (rule.effect !== undefined && !RULE_EFFECTS.has(rule.effect)) {
      throw new PolicyError("INVALID_POLICY", `Rule '${rule.id}' has unknown effect '${rule.effect}'.`);
    }
    if (rule.effect === undefined && !isConstraint) throw new PolicyError("INVALID_POLICY", `Rule '${rule.id}' needs an effect or a constraint.`);
  }
  // Frozen deep enough that a caller mutating its object later cannot change past decisions' meaning.
  return Object.freeze({ version: document.version, rules: Object.freeze(document.rules.map((rule) => Object.freeze({ ...rule }))) });
}

export class PolicyEngine {
  #policy;
  #clock;
  #cache;
  #cacheSize;

  constructor(document, { clock = () => new Date(), cacheSize = 256 } = {}) {
    this.#policy = validatePolicyDocument(document);
    this.#clock = clock;
    this.#cache = new Map();
    this.#cacheSize = Number.isInteger(cacheSize) && cacheSize > 0 ? cacheSize : 256;
  }

  get version() { return this.#policy.version; }

  /**
   * The decision core: effect and reasons only, with no id or timestamp, so
   * it is trivially comparable across calls.
   *
   * `approval` is `{ id, verified: true }` only when the executor has already
   * checked that approval is approved, unconsumed, unexpired, and bound to
   * this exact action digest. The engine does not trust anything else.
   */
  decide({ tenantId, userId, agentId = null, tool, input = {}, grantedPermissions = [], approval = null }) {
    if (!tenantId || !userId) return { effect: "deny", reasons: ["request is missing tenant or user identity"] };
    if (!tool || typeof tool.name !== "string") return { effect: "deny", reasons: ["request names no tool definition"] };
    const request = { tenantId, userId, agentId, tool };
    const cacheKey = JSON.stringify({ tenantId, userId, agentId, tool, input, grantedPermissions, approval });
    if (!approval) {
      const cached = this.#cache.get(cacheKey);
      if (cached) { this.#cache.delete(cacheKey); this.#cache.set(cacheKey, cached); return { ...cached, reasons: [...cached.reasons] }; }
    }
    const applicable = this.#policy.rules.filter((rule) => ruleApplies(rule, request));

    const denials = applicable.filter((rule) => rule.effect === "deny");
    if (denials.length > 0) {
      return this.#remember(cacheKey, { effect: "deny", reasons: denials.map((rule) => `explicit deny by rule '${rule.id}'${rule.reason ? `: ${rule.reason}` : ""}`) }, approval);
    }

    const violations = applicable.map((rule) => constraintViolation(rule, input)).filter(Boolean);
    if (violations.length > 0) return this.#remember(cacheKey, { effect: "deny", reasons: violations }, approval);

    const grants = Array.isArray(grantedPermissions) ? grantedPermissions : [];
    const grant = grants.find((pattern) => matchesPermission(pattern, tool.name));
    if (!grant) return this.#remember(cacheKey, { effect: "deny", reasons: [`default deny: no granted permission covers '${tool.name}'`] }, approval);

    const reasons = [`permission '${grant}' covers '${tool.name}'`];
    const approvalRules = applicable.filter((rule) => rule.effect === "require_approval");
    const needsApproval = tool.consequential || APPROVAL_RISKS.has(tool.risk) || approvalRules.length > 0;
    if (needsApproval) {
      const why = [
        ...(tool.consequential ? ["tool is consequential"] : []),
        ...(APPROVAL_RISKS.has(tool.risk) ? [`tool risk is '${tool.risk}'`] : []),
        ...approvalRules.map((rule) => `rule '${rule.id}' requires approval`),
      ];
      if (approval?.verified === true && typeof approval.id === "string") {
        return { effect: "allow", reasons: [...reasons, ...why, `approval '${approval.id}' granted for this exact action`] };
      }
      return this.#remember(cacheKey, { effect: "require_approval", reasons: [...reasons, ...why] }, approval);
    }
    return this.#remember(cacheKey, { effect: "allow", reasons }, approval);
  }

  #remember(key, result, approval) {
    if (!approval) {
      this.#cache.set(key, result);
      while (this.#cache.size > this.#cacheSize) this.#cache.delete(this.#cache.keys().next().value);
    }
    return result;
  }

  /** A full PolicyDecision record, valid against the shared contract. */
  evaluate(request) {
    const { effect, reasons } = this.decide(request);
    const risk = request?.tool?.risk;
    return assertSchema(policyDecisionSchema, {
      schemaVersion: SCHEMA_VERSION,
      id: newId("policyDecision"),
      effect,
      reasons,
      tool: String(request?.tool?.name ?? "unknown").slice(0, 128),
      ...(risk !== undefined && { risk }),
      tenantId: request?.tenantId || "unknown",
      userId: request?.userId || "unknown",
      agentId: request?.agentId ?? null,
      taskId: request?.taskId ?? null,
      policyVersion: this.#policy.version,
      decidedAt: this.#clock().toISOString(),
    }, "policy decision");
  }
}
