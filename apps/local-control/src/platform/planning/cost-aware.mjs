import { CapabilityRouter, NoQualifyingModelError } from "../models/router.mjs";

/**
 * Cost-aware plan comparison (blueprint §13 N).
 *
 * A candidate execution plan is a list of steps; each step names the tool it
 * uses, the capabilities it needs, and — when it calls a model — the model
 * complexity, model needs and estimated tokens. Every step's model is chosen
 * by the same CapabilityRouter the runtime uses, under the plan's privacy
 * constraint, so the estimated cost is priced from real model profiles
 * rather than guessed.
 *
 * A plan is rejected (with reasons) when:
 *  - a step needs a tool or capability that is not available;
 *  - no model can serve a step under the constraints (e.g. `local_only`
 *    with no capable local model);
 *  - its total estimated cost exceeds `maxCostMicroUsd`, or its latency
 *    exceeds `maxLatencyMs`.
 * Feasible plans are ranked by cost, then latency (or latency first with
 * `prefer: 'latency'`), then step count, then id.
 */

export const DEFAULT_TOOL_LATENCY_MS = 500;
export const DEFAULT_MODEL_LATENCY_MS = 5_000;

export class PlanComparisonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlanComparisonError";
    this.code = code;
  }
}

/**
 * @param input.plans [{ id, description?, steps: [{ tool?, requiredCapabilities?, complexity?, needs?, estimatedTokens?, toolLatencyMs? }] }]
 * @param input.registry a ModelCapabilityRegistry
 * @param input.available { tools?: string[], capabilities?: string[] } — omitted lists mean "not checked"
 * @param input.constraints { privacy?: 'local_only'|'any', maxCostMicroUsd?, maxLatencyMs?, allowedProviders?, minReliability? }
 * @param input.prefer 'cost' (default) | 'latency'
 * @returns { ranked: [...], rejected: [...], best: string|null, reason: string }
 */
export function comparePlans({ plans, registry, router = undefined, available = {}, constraints = {}, prefer = "cost" }) {
  if (!Array.isArray(plans) || plans.length === 0) throw new PlanComparisonError("INVALID_ARGUMENT", "At least one plan is required.");
  if (!registry && !router) throw new PlanComparisonError("INVALID_ARGUMENT", "A model registry (or router) is required to price plans.");
  if (!["cost", "latency"].includes(prefer)) throw new PlanComparisonError("INVALID_ARGUMENT", "prefer must be 'cost' or 'latency'.");
  const modelRouter = router ?? new CapabilityRouter(registry);
  const tools = available.tools ? new Set(available.tools) : null;
  const capabilities = available.capabilities ? new Set(available.capabilities) : null;
  const ids = new Set();

  const evaluated = plans.map((plan, index) => {
    const id = plan?.id ?? `plan-${index + 1}`;
    if (ids.has(id)) throw new PlanComparisonError("DUPLICATE_PLAN", `Plan id '${id}' is used twice.`);
    ids.add(id);
    if (!Array.isArray(plan?.steps) || plan.steps.length === 0) {
      return { id, feasible: false, reasons: ["plan has no steps"], steps: [], costMicroUsd: 0, latencyMs: 0, missingCapabilities: [] };
    }
    const reasons = [];
    const missing = new Set();
    let costMicroUsd = 0;
    let latencyMs = 0;
    const steps = plan.steps.map((step, stepIndex) => {
      const label = `step ${stepIndex + 1}${step.tool ? ` (${step.tool})` : ""}`;
      const out = { index: stepIndex, tool: step.tool ?? null, model: null, costMicroUsd: 0, latencyMs: step.toolLatencyMs ?? (step.tool ? DEFAULT_TOOL_LATENCY_MS : 0) };
      if (step.tool && tools && !tools.has(step.tool)) {
        reasons.push(`${label}: tool '${step.tool}' is not available`);
        missing.add(`tool:${step.tool}`);
      }
      for (const capability of step.requiredCapabilities ?? []) {
        if (capabilities && !capabilities.has(capability)) {
          reasons.push(`${label}: capability '${capability}' is not available`);
          missing.add(capability);
        }
      }
      if (usesModel(step)) {
        try {
          const decision = modelRouter.route({
            task: { complexity: step.complexity ?? "moderate", needs: step.needs ?? {}, ...(step.estimatedTokens && { estimatedTokens: step.estimatedTokens }) },
            constraints: {
              privacy: constraints.privacy ?? "any",
              ...(constraints.allowedProviders && { allowedProviders: constraints.allowedProviders }),
              ...(typeof constraints.minReliability === "number" && { minReliability: constraints.minReliability }),
            },
          });
          out.model = decision.model;
          out.local = decision.profile.local;
          out.costMicroUsd = decision.estimatedCostMicroUsd;
          out.latencyMs += decision.profile.p50LatencyMs ?? DEFAULT_MODEL_LATENCY_MS;
        } catch (error) {
          if (!(error instanceof NoQualifyingModelError)) throw error;
          reasons.push(`${label}: no model qualifies (${error.rejected.map((r) => `${r.id}: ${r.reasons.join("; ")}`).join(", ") || "none registered"})`);
          missing.add(`model:${step.complexity ?? "moderate"}`);
        }
      }
      costMicroUsd += out.costMicroUsd;
      latencyMs += out.latencyMs;
      return out;
    });
    if (typeof constraints.maxCostMicroUsd === "number" && costMicroUsd > constraints.maxCostMicroUsd) {
      reasons.push(`estimated cost ${costMicroUsd} µUSD exceeds budget ${constraints.maxCostMicroUsd} µUSD`);
    }
    if (typeof constraints.maxLatencyMs === "number" && latencyMs > constraints.maxLatencyMs) {
      reasons.push(`estimated latency ${latencyMs} ms exceeds limit ${constraints.maxLatencyMs} ms`);
    }
    return {
      id, description: plan.description ?? null, feasible: reasons.length === 0, reasons, steps,
      costMicroUsd, latencyMs, missingCapabilities: [...missing].sort(),
      privacy: constraints.privacy ?? "any",
    };
  });

  const byCost = (a, b) => a.costMicroUsd - b.costMicroUsd || a.latencyMs - b.latencyMs || a.steps.length - b.steps.length || a.id.localeCompare(b.id);
  const byLatency = (a, b) => a.latencyMs - b.latencyMs || a.costMicroUsd - b.costMicroUsd || a.steps.length - b.steps.length || a.id.localeCompare(b.id);
  const ranked = evaluated.filter((p) => p.feasible).sort(prefer === "latency" ? byLatency : byCost).map((plan, index, all) => ({
    ...plan,
    rank: index + 1,
    reasons: [explainRank(plan, index, all, prefer, constraints)],
  }));
  const rejected = evaluated.filter((p) => !p.feasible);
  return {
    ranked,
    rejected,
    best: ranked[0]?.id ?? null,
    reason: ranked[0]
      ? ranked[0].reasons[0]
      : `no plan satisfies the constraints: ${rejected.map((p) => `${p.id} (${p.reasons.join("; ")})`).join(", ")}`,
  };
}

function usesModel(step) {
  if (step.model === false) return false;
  return step.complexity !== undefined || step.estimatedTokens !== undefined || step.needs !== undefined;
}

function explainRank(plan, index, all, prefer, constraints) {
  const facts = `${plan.costMicroUsd} µUSD, ~${plan.latencyMs} ms, ${plan.steps.length} step(s)`
    + (constraints.privacy === "local_only" ? ", all models local" : "");
  if (all.length === 1) return `only feasible plan (${facts})`;
  if (index === 0) return `${prefer === "latency" ? "fastest" : "cheapest"} feasible plan of ${all.length} (${facts})`;
  const best = all[0];
  return `ranked ${index + 1} of ${all.length}: +${plan.costMicroUsd - best.costMicroUsd} µUSD, ${plan.latencyMs - best.latencyMs >= 0 ? "+" : ""}${plan.latencyMs - best.latencyMs} ms vs ${best.id} (${facts})`;
}
