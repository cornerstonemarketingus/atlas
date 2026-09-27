import { inferSpecification } from "./requirements.mjs";
import { planProject } from "./planner.mjs";

/**
 * The seam between Project Genesis and Atlas's Intelligence Layer.
 *
 * Genesis needs a few reasoning capabilities (turn a prompt into a
 * specification, turn a specification into a plan, choose a model for a
 * task). Another workstream owns model capability, routing, planning
 * intelligence, context retrieval and failure analysis; Genesis does not
 * reimplement any of that. It calls this interface, whose default is the
 * deterministic behaviour in requirements.mjs / planner.mjs, and whatever the
 * Intelligence Layer provides can replace any method without Genesis
 * changing.
 *
 * Contract (all async, all optional to override):
 * - refineSpecification({ prompt, draft }) → spec with the same shape as draft
 * - refinePlan({ spec, draft })            → plan with the same shape as draft
 * - modelFor({ task, attempt })            → { model?, reason } (null = coder default)
 * - explainFailure({ task, evidence })     → { summary, hints[] } for a repair objective
 *
 * Refinements are validated by the caller (service.mjs) and discarded if they
 * break the shape, so a weak model can only fail to help, never corrupt state.
 */
export function createDefaultIntelligence() {
  return {
    name: "deterministic",
    async refineSpecification({ draft }) { return draft; },
    async refinePlan({ draft }) { return draft; },
    async modelFor() { return null; },
    async explainFailure({ evidence }) {
      const lines = String(evidence?.output ?? evidence?.stderr ?? "").split(/\r?\n/u).filter((line) => /error|fail|expected|cannot|undefined|not found|exception/iu.test(line)).slice(0, 12);
      return { summary: lines[0] ?? "A check failed.", hints: lines.slice(1) };
    },
  };
}

/** Merges a partial override onto the defaults so a provider can implement only what it has. */
export function resolveIntelligence(provider = null) {
  const defaults = createDefaultIntelligence();
  if (!provider) return defaults;
  return { ...defaults, ...Object.fromEntries(Object.entries(provider).filter(([, value]) => typeof value === "function" || typeof value === "string")) };
}

/** Structural checks: a refined spec/plan must keep the fields Genesis relies on. */
export function isSpecShape(spec) {
  return Boolean(spec && typeof spec.name === "string" && typeof spec.archetype === "string" && Array.isArray(spec.pages) && Array.isArray(spec.entities)
    && Array.isArray(spec.workflows) && Array.isArray(spec.acceptanceCriteria) && Array.isArray(spec.assumptions) && Array.isArray(spec.questions) && spec.auth && typeof spec.auth === "object");
}

export function isPlanShape(plan) {
  return Boolean(plan && typeof plan.template === "string" && Array.isArray(plan.tasks) && plan.tasks.length > 0
    && plan.tasks.every((t) => t && typeof t.id === "string" && typeof t.title === "string" && typeof t.objective === "string" && Array.isArray(t.dependsOn) && Array.isArray(t.verification) && typeof t.executor === "string"));
}

export { inferSpecification, planProject };
