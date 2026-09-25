/**
 * Opportunity Briefs, Implementation Proposals, council reviews and the
 * Innovation Backlog state machine.
 *
 * The rules here exist so autonomy never turns into random activity: a brief
 * without evidence is refused, a confidence claim must be backed by the
 * evidence it cites, and an opportunity cannot jump from an idea to a build
 * without research, a product review, a Decision Packet and a human (or an
 * explicitly configured policy) approving that exact packet.
 */

export class InnovationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "InnovationError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const OPPORTUNITY_TRANSITIONS = Object.freeze({
  DISCOVERED: ["RESEARCHING", "VALIDATED", "REJECTED", "ARCHIVED"],
  RESEARCHING: ["VALIDATED", "REJECTED", "ARCHIVED"],
  VALIDATED: ["PROPOSED", "RESEARCHING", "REJECTED", "ARCHIVED"],
  PROPOSED: ["NEEDS_REVIEW", "RESEARCHING", "REJECTED", "ARCHIVED"],
  NEEDS_REVIEW: ["APPROVED", "PROPOSED", "REJECTED"],
  APPROVED: ["BUILDING", "ARCHIVED"],
  BUILDING: ["VERIFYING", "ARCHIVED"],
  VERIFYING: ["READY_TO_LAUNCH", "BUILDING", "ITERATE"],
  READY_TO_LAUNCH: ["LAUNCHED", "BUILDING", "ARCHIVED"],
  LAUNCHED: ["MEASURING"],
  MEASURING: ["SUCCESSFUL", "ITERATE"],
  SUCCESSFUL: ["ARCHIVED"],
  ITERATE: ["PROPOSED", "ARCHIVED"],
  REJECTED: ["ARCHIVED"],
  ARCHIVED: [],
});

export const OPPORTUNITY_STATES = Object.freeze(Object.keys(OPPORTUNITY_TRANSITIONS));

/** States in which an opportunity still occupies the pipeline. */
export const ACTIVE_STATES = Object.freeze([
  "DISCOVERED", "RESEARCHING", "VALIDATED", "PROPOSED", "NEEDS_REVIEW", "APPROVED",
  "BUILDING", "VERIFYING", "READY_TO_LAUNCH", "LAUNCHED", "MEASURING", "ITERATE",
]);

export function assertOpportunityTransition(from, to) {
  if (!OPPORTUNITY_TRANSITIONS[from]?.includes(to)) {
    throw new InnovationError("ILLEGAL_OPPORTUNITY_TRANSITION", `An opportunity cannot move from '${from}' to '${to}'.`, { from, to });
  }
}

export const EFFORT_LEVELS = Object.freeze(["Small", "Medium", "Large", "Major"]);
export const CONFIDENCE_LEVELS = Object.freeze(["High", "Medium", "Low"]);
export const EVIDENCE_KINDS = Object.freeze([
  "user_feedback", "support_ticket", "feature_request", "analytics", "conversion", "retention",
  "competitor", "technology", "integration", "repository_signal", "test_failure", "incident",
  "cost", "market_research", "experiment_result", "other",
]);
export const EVIDENCE_STRENGTHS = Object.freeze(["strong", "moderate", "weak"]);
export const RISK_CATEGORIES = Object.freeze(["technical", "product", "security", "operational", "legal", "financial"]);
export const COUNCIL_STANCES = Object.freeze(["support", "concerns", "oppose"]);

const MAX_TEXT = 4000;
const MAX_SHORT = 300;

function text(value, field, { max = MAX_TEXT, min = 1 } = {}) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new InnovationError("INVALID_BRIEF", `'${field}' must be text of ${min}–${max} characters.`, { field });
  }
  return value.trim();
}

function list(value, field, { min = 1, max = 32 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new InnovationError("INVALID_BRIEF", `'${field}' must be a list of ${min}–${max} entries.`, { field });
  }
  return value;
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new InnovationError("INVALID_BRIEF", `'${field}' must be one of ${allowed.join(", ")}.`, { field });
  return value;
}

function optionalText(value, field, max = MAX_TEXT) {
  return value === undefined || value === null || value === "" ? null : text(value, field, { max });
}

/**
 * Validates and normalizes an Opportunity Brief. Throws InvalidBrief with the
 * first field that fails; returns a plain, canonical object otherwise.
 */
export function validateOpportunityBrief(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InnovationError("INVALID_BRIEF", "A brief must be an object.");
  const evidence = list(input.evidence, "evidence", { min: 1, max: 50 }).map((item, index) => {
    const at = `evidence[${index}]`;
    if (!item || typeof item !== "object") throw new InnovationError("INVALID_BRIEF", `'${at}' must be an object.`, { field: at });
    return {
      kind: oneOf(item.kind, EVIDENCE_KINDS, `${at}.kind`),
      summary: text(item.summary, `${at}.summary`, { max: 2000 }),
      // Every piece of evidence names where it came from, so a reviewer can check it.
      source: text(item.source, `${at}.source`, { max: 1000 }),
      strength: oneOf(item.strength ?? "moderate", EVIDENCE_STRENGTHS, `${at}.strength`),
      observedAt: optionalText(item.observedAt, `${at}.observedAt`, 64),
    };
  });
  const confidenceInput = input.confidence ?? {};
  const confidence = {
    level: oneOf(confidenceInput.level, CONFIDENCE_LEVELS, "confidence.level"),
    reasons: list(confidenceInput.reasons, "confidence.reasons", { min: 1, max: 10 }).map((r, i) => text(r, `confidence.reasons[${i}]`, { max: 1000 })),
  };
  // A High-confidence claim must be earned by the evidence it cites.
  if (confidence.level === "High") {
    const strong = evidence.filter((e) => e.strength === "strong").length;
    const sources = new Set(evidence.map((e) => e.source)).size;
    if (strong < 1 || sources < 2) {
      throw new InnovationError("CONFIDENCE_NOT_SUPPORTED", "High confidence requires at least one strong piece of evidence and two independent sources.", { strong, sources });
    }
  }
  const costInput = input.estimatedCost ?? {};
  const brief = {
    title: text(input.title, "title", { max: 160 }),
    problem: text(input.problem, "problem"),
    targetUser: text(input.targetUser, "targetUser", { max: 1000 }),
    evidence,
    proposedSolution: text(input.proposedSolution, "proposedSolution"),
    valueHypothesis: text(input.valueHypothesis, "valueHypothesis"),
    differentiation: text(input.differentiation, "differentiation"),
    implementationScope: list(input.implementationScope, "implementationScope", { min: 1, max: 30 }).map((s, i) => text(s, `implementationScope[${i}]`, { max: MAX_SHORT })),
    estimatedEffort: oneOf(input.estimatedEffort, EFFORT_LEVELS, "estimatedEffort"),
    estimatedCost: {
      development: text(costInput.development, "estimatedCost.development", { max: 1000 }),
      runtime: text(costInput.runtime, "estimatedCost.runtime", { max: 1000 }),
      externalServices: text(costInput.externalServices ?? "None expected.", "estimatedCost.externalServices", { max: 1000 }),
    },
    risks: list(input.risks, "risks", { min: 1, max: 20 }).map((risk, i) => ({
      category: oneOf(risk?.category, RISK_CATEGORIES, `risks[${i}].category`),
      description: text(risk?.description, `risks[${i}].description`, { max: 1000 }),
      mitigation: optionalText(risk?.mitigation, `risks[${i}].mitigation`, 1000),
    })),
    successMetrics: list(input.successMetrics, "successMetrics", { min: 1, max: 12 }).map((metric, i) => ({
      name: text(metric?.name, `successMetrics[${i}].name`, { max: 200 }),
      target: text(metric?.target, `successMetrics[${i}].target`, { max: 500 }),
      measurement: text(metric?.measurement, `successMetrics[${i}].measurement`, { max: 1000 }),
      baseline: optionalText(metric?.baseline, `successMetrics[${i}].baseline`, 500),
    })),
    confidence,
    originality: optionalText(input.originality, "originality", 2000),
  };
  // Competitive research identifies problems and gaps; it never licenses copying.
  if (evidence.some((e) => e.kind === "competitor") && !brief.originality) {
    throw new InnovationError("ORIGINALITY_REQUIRED",
      "A brief that cites competitor evidence must state how the proposed solution is an original Atlas design rather than a copy of another product's implementation, branding or expression.",
      { field: "originality" });
  }
  return brief;
}

/** Validates the Product Executive's Implementation Proposal. */
export function validateImplementationProposal(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InnovationError("INVALID_PROPOSAL", "A proposal must be an object.");
  const wrap = (fn) => {
    try { return fn(); }
    catch (error) { if (error instanceof InnovationError) error.code = "INVALID_PROPOSAL"; throw error; }
  };
  return wrap(() => ({
    summary: text(input.summary, "summary"),
    mvpScope: list(input.mvpScope, "mvpScope", { min: 1, max: 30 }).map((s, i) => text(s, `mvpScope[${i}]`, { max: 1000 })),
    outOfScope: list(input.outOfScope ?? [], "outOfScope", { min: 0, max: 30 }).map((s, i) => text(s, `outOfScope[${i}]`, { max: 1000 })),
    acceptanceCriteria: list(input.acceptanceCriteria, "acceptanceCriteria", { min: 1, max: 32 }).map((s, i) => text(s, `acceptanceCriteria[${i}]`, { max: 1000 })),
    dependencies: list(input.dependencies ?? [], "dependencies", { min: 0, max: 30 }).map((s, i) => text(s, `dependencies[${i}]`, { max: 500 })),
    affectedSystems: list(input.affectedSystems, "affectedSystems", { min: 1, max: 30 }).map((s, i) => text(s, `affectedSystems[${i}]`, { max: MAX_SHORT })),
    alternativesConsidered: list(input.alternativesConsidered ?? [], "alternativesConsidered", { min: 0, max: 10 }).map((s, i) => text(s, `alternativesConsidered[${i}]`, { max: 1000 })),
    architectureImpact: optionalText(input.architectureImpact, "architectureImpact"),
    uxConcept: optionalText(input.uxConcept, "uxConcept"),
    implementationPlan: list(input.implementationPlan, "implementationPlan", { min: 1, max: 40 }).map((s, i) => text(s, `implementationPlan[${i}]`, { max: 1000 })),
    // Which peer organizations the build needs; commissioning uses this list.
    commission: list(input.commission ?? ["engineering"], "commission", { min: 1, max: 4 }).map((s, i) => oneOf(s, ["engineering", "design", "computer_operations", "research"], `commission[${i}]`)),
    estimatedEffort: oneOf(input.estimatedEffort, EFFORT_LEVELS, "estimatedEffort"),
  }));
}

export function validateCouncilReview(input) {
  if (!input || typeof input !== "object") throw new InnovationError("INVALID_REVIEW", "A review must be an object.");
  try {
    return {
      stance: oneOf(input.stance, COUNCIL_STANCES, "stance"),
      summary: text(input.summary, "summary", { max: 2000 }),
      findings: list(input.findings ?? [], "findings", { min: 0, max: 20 }).map((s, i) => text(s, `findings[${i}]`, { max: 1000 })),
      conditions: list(input.conditions ?? [], "conditions", { min: 0, max: 20 }).map((s, i) => text(s, `conditions[${i}]`, { max: 1000 })),
    };
  } catch (error) {
    if (error instanceof InnovationError) error.code = "INVALID_REVIEW";
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Similarity (Opportunity Memory duplicate detection)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(("a an and are as at be by can for from has have in into is it its of on or that the their them this to "
  + "was were will with without we our you your users user atlas should would could not no more less than so which who what when").split(" "));

/** Lower-case content words, lightly stemmed, for set similarity. */
export function tokenize(value) {
  return new Set(String(value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/(ization|isation|ations?|izes?|ises?|ions?|ing|ed|es|s)$/u, ""))
    .filter((w) => w.length > 2));
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Share of the query's words found in the candidate: for short free-text searches. */
export function coverage(query, candidate) {
  if (!query.size) return 0;
  let shared = 0;
  for (const token of query) if (candidate.has(token)) shared += 1;
  return shared / query.size;
}

/** The text an opportunity is compared on: what problem, for whom, solved how. */
export function briefFingerprintText(brief) {
  return [brief.title, brief.problem, brief.proposedSolution].join(" \n ");
}
