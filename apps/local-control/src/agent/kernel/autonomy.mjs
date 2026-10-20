/**
 * Adaptive autonomy (ROADMAP Track B8): how much Atlas may do on its own is
 * decided per action, from what the action does, not per tool family alone.
 *
 *   0 auto · 1 auto + audit · 2 auto if reversible · 3 ask · 4 strong confirmation · 5 prohibited
 *
 * A level comes from the action's effects: does it write, can it be undone,
 * does it spend money, expose a credential, talk to the outside world, touch
 * production, or destroy data; how confident the agent is; and the tool's
 * declared risk. Effects come from the tool's own `effects` declaration when
 * it has one, else from its capability, and the arguments can only add to
 * them (an `rm -rf` in a command it runs, a production target, a key in a message).
 *
 * The engine never loosens the owner's policy. Levels 0 to 3 follow the
 * owner's allow / ask / deny setting; level 4 asks even where the owner
 * allowed, and the approval must be confirmed a second time; level 5 is
 * refused. Precedent (the owner approving the same kind of action again and
 * again) only ever becomes a suggestion the owner can accept, never a silent
 * change.
 */

export const AUTONOMY_LEVELS = Object.freeze([
  { level: 0, mode: "auto", label: "Atlas does it" },
  { level: 1, mode: "audit", label: "Atlas does it and records it" },
  { level: 2, mode: "reversible", label: "Atlas does it because it can be undone" },
  { level: 3, mode: "ask", label: "Atlas asks first" },
  { level: 4, mode: "confirm", label: "Atlas asks, and you confirm twice" },
  { level: 5, mode: "prohibited", label: "Atlas will not do this" },
]);

const NONE = Object.freeze({});
const SANDBOXED = Object.freeze({ writes: true, reversible: true, sandboxed: true });
const CHECKPOINTED = Object.freeze({ writes: true, reversible: true });
const IRREVERSIBLE = Object.freeze({ writes: true, reversible: false });
const OUTSIDE = Object.freeze({ writes: true, reversible: false, external: true });

/** What each capability does when its tools declare nothing more specific. */
export const CAPABILITY_EFFECTS = Object.freeze({
  "repository.read": NONE,
  "filesystem.read": NONE,
  "browser.read": NONE,
  "desktop.observe": NONE,
  "infrastructure.read": NONE,
  "genesis.plan": NONE,
  "communications.draft": SANDBOXED,
  "workflow.prepare": SANDBOXED,
  "genesis.build": SANDBOXED,
  "innovation.build": SANDBOXED,
  "code.write": CHECKPOINTED,
  "repository.write": CHECKPOINTED,
  "repository.git": CHECKPOINTED,
  "filesystem.write": CHECKPOINTED,
  "repository.execute": IRREVERSIBLE,
  "terminal.run": IRREVERSIBLE,
  "desktop.control": IRREVERSIBLE,
  "computer.high_risk": IRREVERSIBLE,
  "atlas.self_improve": IRREVERSIBLE,
  "browser.control": OUTSIDE,
  "browser.submit": OUTSIDE,
  "browser.upload": OUTSIDE,
  "communications.send": OUTSIDE,
  "publish.remote": OUTSIDE,
  "deploy.remote": Object.freeze({ ...OUTSIDE, production: true }),
  "infrastructure.write": Object.freeze({ ...OUTSIDE, production: true }),
  "payments.spend": Object.freeze({ ...OUTSIDE, money: true }),
});

const DESTRUCTIVE = /\brm\s+-[a-z]*(?:r[a-z]*f|f[a-z]*r)|\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b|\bgit\s+push\b[^\n]*\s(?:--force\b|-f\b)|\bgit\s+reset\s+--hard\b|\bmkfs\b|\bdd\s+if=|\bdelete\s+from\s+[\w."]+\s*(?:;|$)/iu;
const CREDENTIAL = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const TARGET_FIELDS = new Set(["target", "environment", "env", "stage"]);
const PRODUCTION = /^(?:prod|production|live)$/iu;
const MONEY_FIELDS = new Set(["amount", "amountusd", "price", "cost", "costusd", "usd"]);
const MAX_SCAN = 200;

/** The effects of one action: the tool's declaration or capability, plus what its arguments reveal. */
export function effectsFor(tool, input = {}) {
  const declared = tool?.effects ?? CAPABILITY_EFFECTS[tool?.capability];
  const effects = { ...(declared ?? { writes: true, reversible: false, unknown: true }) };
  // A destructive command matters where the action runs things; in a file a
  // restorable write puts down (a Makefile's `rm -rf build`) it is only text.
  const executes = !effects.reversible;
  // A tool that only files a request is judged where the request is decided.
  if (effects.requestOnly) return effects;
  let scanned = 0;
  const visit = (value, key) => {
    if (scanned++ > MAX_SCAN) return;
    if (typeof value === "string") {
      if (executes && DESTRUCTIVE.test(value)) effects.destroys = true;
      if (CREDENTIAL.test(value)) effects.credentials = true;
      if (key && TARGET_FIELDS.has(key.toLowerCase()) && PRODUCTION.test(value.trim())) effects.production = true;
    } else if (typeof value === "number") {
      if (key && MONEY_FIELDS.has(key.toLowerCase()) && value > 0) effects.money = true;
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
    } else if (value && typeof value === "object") {
      for (const [name, entry] of Object.entries(value)) visit(entry, name);
    }
  };
  visit(input, null);
  return effects;
}

/**
 * The autonomy level of one action, with the reasons for it.
 * @param {{ tool: object, input?: object, confidence?: number | null }} action
 * @returns {{ level: number, mode: string, label: string, effects: object, reasons: string[] }}
 */
export function assessAction({ tool, input = {}, confidence = null }) {
  const effects = effectsFor(tool, input);
  const reasons = [];
  let level;
  if (effects.credentials && effects.external) { level = 5; reasons.push("a credential would leave this machine"); }
  else if (effects.destroys && effects.production) { level = 5; reasons.push("it would destroy data in production"); }
  else if (effects.money || effects.production || effects.destroys || effects.credentials) {
    level = 4;
    if (effects.money) reasons.push("it spends money");
    if (effects.production) reasons.push("it affects production");
    if (effects.destroys) reasons.push("it destroys data");
    if (effects.credentials) reasons.push("it handles a credential");
  } else if (effects.external || (effects.writes && !effects.reversible)) {
    level = 3;
    reasons.push(effects.unknown ? "Atlas does not know what this tool changes" : effects.external ? "it acts outside this machine" : "it cannot be undone");
  } else if (effects.writes && !effects.sandboxed) { level = 2; reasons.push("it changes files that can be restored"); }
  else if (effects.writes) { level = 1; reasons.push(effects.requestOnly ? "it only files a request that is approved separately" : "it works only inside Atlas's own workspace"); }
  else { level = 0; reasons.push("it only reads"); }

  const floor = tool?.risk === "critical" ? 4 : tool?.risk === "high" || tool?.requiresApproval ? 3 : 0;
  if (floor > level) {
    level = floor;
    reasons.push(tool?.risk === "critical" ? "the tool is declared critical" : tool?.risk === "high" ? "the tool is declared high risk" : "the tool always asks");
  }
  // Low confidence costs one level of autonomy, but never makes an action prohibited.
  if (typeof confidence === "number" && confidence < 0.5 && level < 4) {
    level += 1;
    reasons.push(`the agent is unsure (confidence ${confidence.toFixed(2)})`);
  }
  return { ...AUTONOMY_LEVELS[level], effects, reasons };
}

/**
 * Combines the owner's decision for an action with its autonomy level.
 * Only ever tightens: deny stays deny, 5 is refused, 4 asks with strong confirmation.
 * @returns {{ decision: "allow" | "ask" | "deny", autonomy: object }}
 */
export function applyAutonomy(decision, assessment) {
  const autonomy = { level: assessment.level, mode: assessment.mode, reasons: assessment.reasons, confirmation: assessment.level === 4 ? "strong" : null };
  if (decision === "deny") return { decision: "deny", autonomy };
  if (assessment.level === 5) return { decision: "deny", autonomy };
  if (assessment.level === 4) return { decision: "ask", autonomy };
  return { decision: decision === "allow" ? "allow" : "ask", autonomy };
}

/**
 * Wraps a ToolRegistry policy function so every decision carries its autonomy level.
 * `audit(entry)` is called for actions that run on their own at level 1 or above.
 */
export function withAutonomy(policy, { audit = () => {} } = {}) {
  return (capability, risk, tool, input, context = {}) => {
    const base = policy(capability, risk, tool, input, context);
    const assessment = assessAction({ tool: { ...tool, capability, risk }, input, confidence: context.confidence ?? null });
    const result = applyAutonomy(base, assessment);
    if (result.decision === "allow" && assessment.level >= 1) {
      audit({ tool: tool?.name ?? capability, level: assessment.level, reasons: assessment.reasons });
    }
    return result;
  };
}

/**
 * Policies the owner could relax, from precedent: a capability set to "ask"
 * whose most recent decisions were all approvals (at least `minApproved`),
 * whose tools never rise above level 3 and do not always ask anyway. Suggestions only; nothing changes
 * until the owner accepts one.
 */
export function suggestRelaxations({ policies, approvals, tools, minApproved = 5, window = 20 }) {
  const levels = new Map();
  const alwaysAsks = new Set();
  for (const tool of tools) {
    const { level } = assessAction({ tool });
    levels.set(tool.capability, Math.max(levels.get(tool.capability) ?? 0, level));
    // Relaxing the policy would not change a tool that always asks.
    if (tool.requiresApproval) alwaysAsks.add(tool.capability);
  }
  const suggestions = [];
  for (const policy of policies) {
    if (policy.decision !== "ask") continue;
    const level = levels.get(policy.capability);
    if (level === undefined || level > 3 || alwaysAsks.has(policy.capability)) continue;
    const recent = approvals
      .filter((approval) => approval.capability === policy.capability && ["approved", "denied"].includes(approval.status))
      .sort((a, b) => String(b.resolvedAt ?? b.requestedAt).localeCompare(String(a.resolvedAt ?? a.requestedAt)))
      .slice(0, window);
    const approved = recent.filter((approval) => approval.status === "approved").length;
    if (approved < minApproved || approved !== recent.length) continue;
    suggestions.push({
      capability: policy.capability,
      level,
      approved,
      reason: `You approved the last ${approved} requests for ${policy.capability} and denied none.`,
    });
  }
  return suggestions;
}
