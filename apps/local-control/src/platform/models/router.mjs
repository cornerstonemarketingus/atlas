/**
 * Capability-based model router (blueprint §9).
 *
 * Chooses a model profile from a ModelCapabilityRegistry for one task:
 *  - hard filters first — privacy (`local_only` never leaves the machine),
 *    allowed providers, required capabilities, minimum context, budget;
 *  - then ordering by task complexity — `simple` takes the cheapest capable
 *    model, `complex` the most reliable one, `moderate` the cheapest model
 *    that clears a reliability floor (falling back to the most reliable);
 *  - fallbacks are the rest of that same filtered list, so a fallback can
 *    never break a constraint the primary had to meet.
 * Capabilities are read through `registry.effective()`, so measured values
 * (from the capability suite) override declared ones.
 *
 * Relationship to src/agent/models/router.mjs: that module executes a static,
 * operator-configured task→endpoint table with ordered failover and is what
 * the local agent runtime calls today. This router decides *which* profile to
 * use; its `{ model, fallbacks }` answer can be turned into that module's
 * ordered route list (see `toAgentRoutes`) so execution/failover stays in one
 * place. Neither replaces the other.
 */
import { validateToolCall } from "./tool-call.mjs";

export { validateToolCall };
export const COMPLEXITIES = Object.freeze(["simple", "moderate", "complex"]);
const DEFAULT_TOKENS = Object.freeze({ in: 4_000, out: 1_000 });

export class NoQualifyingModelError extends Error {
  constructor(message, rejected) {
    super(message);
    this.name = "NoQualifyingModelError";
    this.code = "NO_QUALIFYING_MODEL";
    this.rejected = rejected;
  }
}

export function estimateCostMicroUsd(profile, tokens = DEFAULT_TOKENS) {
  return Math.ceil(((tokens.in ?? 0) * profile.costPerMTokIn + (tokens.out ?? 0) * profile.costPerMTokOut) / 1_000_000);
}

export class CapabilityRouter {
  #registry;
  #moderateReliabilityFloor;
  #maxFallbacks;

  constructor(registry, { moderateReliabilityFloor = 0.8, maxFallbacks = 3 } = {}) {
    this.#registry = registry;
    this.#moderateReliabilityFloor = moderateReliabilityFloor;
    this.#maxFallbacks = maxFallbacks;
  }

  /**
   * @param task { complexity, needs: { vision?, toolCalls?, structuredOutput?, minContext? }, estimatedTokens?: { in, out } }
   * @param constraints { privacy: 'local_only'|'any', maxCostMicroUsd?, allowedProviders?, preferredModel?, minReliability? }
   * @returns { model, profile, reason, fallbacks, estimatedCostMicroUsd }
   */
  route({ task = {}, constraints = {} } = {}) {
    const complexity = task.complexity ?? "moderate";
    if (!COMPLEXITIES.includes(complexity)) throw new TypeError(`task.complexity must be one of ${COMPLEXITIES.join(", ")}.`);
    const privacy = constraints.privacy ?? "any";
    if (!["local_only", "any"].includes(privacy)) throw new TypeError("constraints.privacy must be 'local_only' or 'any'.");
    const needs = task.needs ?? {};
    const tokens = { ...DEFAULT_TOKENS, ...(task.estimatedTokens ?? {}) };
    if (needs.minContext && !task.estimatedTokens?.in) tokens.in = needs.minContext;

    const qualified = [];
    const rejected = [];
    for (const profile of this.#registry.list()) {
      const reasons = disqualify(profile, { privacy, needs, constraints, tokens });
      if (reasons.length === 0) qualified.push({ profile, cost: estimateCostMicroUsd(profile, tokens) });
      else rejected.push({ id: profile.id, reasons });
    }
    if (qualified.length === 0) {
      const detail = rejected.length === 0 ? "no model profiles are registered" : rejected.map((item) => `${item.id} (${item.reasons.join("; ")})`).join(", ");
      throw new NoQualifyingModelError(`No model satisfies this ${complexity} task under the given constraints: ${detail}.`, rejected);
    }

    const ordered = this.#order(qualified, complexity);
    let reason = describe(complexity, ordered[0], this.#moderateReliabilityFloor, ordered);
    if (constraints.preferredModel) {
      const index = ordered.findIndex((item) => item.profile.id === constraints.preferredModel);
      if (index > 0) {
        const [preferred] = ordered.splice(index, 1);
        ordered.unshift(preferred);
        reason = `preferred model ${preferred.profile.id} meets every constraint`;
      } else if (index === -1) {
        const why = rejected.find((item) => item.id === constraints.preferredModel);
        reason += `; preferred model ${constraints.preferredModel} was not used (${why ? why.reasons.join("; ") : "not registered"})`;
      } else {
        reason = `preferred model ${ordered[0].profile.id} meets every constraint`;
      }
    }
    const [chosen, ...rest] = ordered;
    return {
      model: chosen.profile.id,
      profile: chosen.profile,
      reason,
      fallbacks: rest.slice(0, this.#maxFallbacks).map((item) => item.profile.id),
      estimatedCostMicroUsd: chosen.cost,
    };
  }

  #order(qualified, complexity) {
    const byCost = (a, b) => a.cost - b.cost || b.profile.reliability - a.profile.reliability || latency(a) - latency(b) || a.profile.id.localeCompare(b.profile.id);
    const byStrength = (a, b) => b.profile.reliability - a.profile.reliability || a.cost - b.cost || latency(a) - latency(b) || a.profile.id.localeCompare(b.profile.id);
    if (complexity === "simple") return [...qualified].sort(byCost);
    if (complexity === "complex") return [...qualified].sort(byStrength);
    const floor = this.#moderateReliabilityFloor;
    const good = qualified.filter((item) => item.profile.reliability >= floor).sort(byCost);
    const weak = qualified.filter((item) => item.profile.reliability < floor).sort(byStrength);
    return [...good, ...weak];
  }
}

function disqualify(profile, { privacy, needs, constraints, tokens }) {
  const reasons = [];
  if (privacy === "local_only" && !profile.local) reasons.push("not local");
  if (Array.isArray(constraints.allowedProviders) && !constraints.allowedProviders.includes(profile.provider)) reasons.push(`provider ${profile.provider} not allowed`);
  for (const key of ["vision", "toolCalls", "structuredOutput"]) {
    if (needs[key] && profile.capabilities[key] !== true) reasons.push(`no ${key} (${profile.sources[key]})`);
  }
  if (needs.minContext && profile.capabilities.contextTokens < needs.minContext) reasons.push(`context ${profile.capabilities.contextTokens} < ${needs.minContext} (${profile.sources.contextTokens})`);
  if (typeof constraints.minReliability === "number" && profile.reliability < constraints.minReliability) reasons.push(`reliability ${profile.reliability} < ${constraints.minReliability}`);
  if (typeof constraints.maxCostMicroUsd === "number") {
    const cost = estimateCostMicroUsd(profile, tokens);
    if (cost > constraints.maxCostMicroUsd) reasons.push(`estimated cost ${cost} µUSD > budget ${constraints.maxCostMicroUsd}`);
  }
  return reasons;
}

function latency(item) {
  return item.profile.p50LatencyMs ?? Number.MAX_SAFE_INTEGER;
}

function describe(complexity, chosen, floor, ordered) {
  const p = chosen.profile;
  const facts = `reliability ${p.reliability} (${p.sources.reliability}), est. ${chosen.cost} µUSD, ${p.local ? "local" : "cloud"}`;
  if (complexity === "simple") return `simple task: cheapest capable model of ${ordered.length} (${facts})`;
  if (complexity === "complex") return `complex task: most reliable capable model of ${ordered.length} (${facts})`;
  return p.reliability >= floor
    ? `moderate task: cheapest model with reliability >= ${floor} (${facts})`
    : `moderate task: no model reaches reliability ${floor}; using the most reliable (${facts})`;
}

/**
 * Converts a routing decision into the ordered route list that
 * agent/models/router.mjs executes (it tries routes for a task in order).
 * Profiles without an endpoint are skipped: that runtime only speaks
 * OpenAI-compatible HTTP.
 */
export function toAgentRoutes(decision, registry, agentTask) {
  return [decision.model, ...decision.fallbacks]
    .map((id) => registry.effective(id))
    .filter((profile) => profile.endpoint)
    .map((profile) => ({ task: agentTask, model: profile.model, endpoint: profile.endpoint, contextWindow: profile.capabilities.contextTokens, contextSource: profile.sources.contextTokens }));
}
