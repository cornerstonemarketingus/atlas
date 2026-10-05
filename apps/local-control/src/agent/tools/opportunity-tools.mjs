/**
 * Opportunity tools: how an agent run (chat, team step, a later mission) uses
 * the opportunity system. They call the same service the owner's page does, so
 * the rules are the same ones: an agent can start a hunt, read the ranked
 * list, claim only an approved (or AUTO) record, and report that it applied or
 * lost. It cannot approve, and it cannot record a win.
 */
const RECORDS = Object.freeze({ writes: true, reversible: true, sandboxed: true });

const brief = (opportunity) => ({
  id: opportunity.id, title: opportunity.title, url: opportunity.url, kind: opportunity.kind, status: opportunity.status,
  class: opportunity.executionClass, why: opportunity.classReasons, score: opportunity.score,
  payUsd: opportunity.payoutMinUsd === null ? null : [opportunity.payoutMinUsd, opportunity.payoutMaxUsd], payUnit: opportunity.payoutUnit,
  hours: opportunity.estimatedHours, deadline: opportunity.deadline, requirements: opportunity.requirements,
  // The application's own questions. Atlas never answers them for the owner.
  questionsForOwner: opportunity.questions,
});

/** @param {() => import("../../opportunity/service.mjs").OpportunityService | null} getService */
export function registerOpportunityTools(registry, getService) {
  const need = () => {
    const service = getService();
    if (!service) throw Object.assign(new Error("The opportunity system is not running in this process."), { code: "NO_OPPORTUNITIES" });
    return service;
  };

  registry.register({
    name: "opportunity.hunt",
    description: "Find legitimate paid opportunities for a goal such as 'make $500 this week'. Searches the web, normalizes what it finds (pay, time, deadline, requirements), ranks it and stores it. Returns at once; read the results with opportunity.list.",
    capability: "opportunity.scout",
    risk: "moderate",
    effects: RECORDS,
    timeoutMs: 10_000,
    maxOutputCharacters: 2_000,
    requiresApproval: false,
    inputSchema: { type: "object", required: ["goal"], properties: { goal: { type: "string", minLength: 3, maxLength: 1000 } } },
    async execute({ input }) {
      const hunt = need().startHunt({ goal: input.goal });
      return JSON.stringify({ hunt: hunt.id, state: hunt.state, targetUsd: hunt.targetUsd, horizonDays: hunt.horizonDays });
    },
  });

  registry.register({
    name: "opportunity.list",
    description: "List stored opportunities, best first (expected value per hour). Each has an execution class: AUTO, APPROVAL_REQUIRED or MANUAL. Skipped, expired and rejected ones are not shown unless asked for.",
    capability: "opportunity.read",
    risk: "low",
    timeoutMs: 10_000,
    maxOutputCharacters: 12_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["discovered", "approved", "manual", "pursuing", "applied", "won", "lost", "skipped", "expired", "rejected"] },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    },
    async execute({ input }) {
      const service = need();
      const all = service.list(input.status ? { status: input.status } : {});
      const shown = input.status ? all : all.filter((opportunity) => !["skipped", "expired", "rejected", "lost"].includes(opportunity.status));
      return JSON.stringify({ counts: service.counts(), opportunities: shown.slice(0, input.limit ?? 20).map(brief) });
    },
  });

  registry.register({
    name: "opportunity.claim",
    description: "Claim an opportunity before working on it. Only an approved one, or an AUTO one, can be claimed, and only once; this is how Atlas avoids pursuing the same thing twice.",
    capability: "opportunity.pursue",
    risk: "moderate",
    effects: RECORDS,
    timeoutMs: 10_000,
    maxOutputCharacters: 4_000,
    requiresApproval: false,
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 4, maxLength: 80 } } },
    async execute({ input }) {
      return JSON.stringify({ claimed: brief(need().claim(input.id)) });
    },
  });

  registry.register({
    name: "opportunity.report",
    description: "Report what happened to an opportunity you claimed: 'applied' (you submitted it) or 'lost' (it was not possible or not worth it). Only the owner records a win.",
    capability: "opportunity.pursue",
    risk: "moderate",
    effects: RECORDS,
    timeoutMs: 10_000,
    maxOutputCharacters: 2_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["id", "outcome"],
      properties: { id: { type: "string", minLength: 4, maxLength: 80 }, outcome: { type: "string", enum: ["applied", "lost"] }, note: { type: "string", maxLength: 300, default: "" } },
    },
    async execute({ input }) {
      const updated = need().report(input.id, input.outcome, input.note);
      return JSON.stringify({ id: updated.id, status: updated.status });
    },
  });
}
