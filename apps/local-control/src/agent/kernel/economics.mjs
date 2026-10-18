/**
 * Capability economics (ROADMAP Track B4): pick the cheapest reliable path to
 * a goal, not just "which model".
 *
 * A candidate is any way to do the work (a local model, a hosted model,
 * deterministic code, another agent, a person), with an estimate of how
 * likely it is to succeed and what it costs:
 *
 *   { id, successRate, minutes, costUsd, privacy: "local"|"remote", risk: 0..5, evidence }
 *
 * Budgets are hard limits (money, time, risk, "local only"); within them the
 * score is expected success, minus time, money and privacy costs:
 *
 *   score = successRate − minutes × perMinute − costUsd × perDollar − privacy − risk
 *
 * Success rates come from Atlas's own history (the world state's verified and
 * unverified runs), as a Beta(1, 1) posterior mean, so an untried candidate
 * starts at 0.5 and earns or loses its place with evidence. Every decision is
 * returned with its reasons, so it can be shown and audited.
 */

export const DEFAULT_WEIGHTS = Object.freeze({ perMinute: 0.01, perDollar: 0.5, remotePrivacy: 0.05, perRisk: 0.05 });
const UNKNOWN_MINUTES = 10;

/**
 * What Atlas's history says about runs matching a filter.
 * @returns {{ runs: number, verified: number, successRate: number, minutes: number | null }}
 */
export function estimateFromHistory(world, { harness = null, model = null } = {}) {
  let runs = 0;
  let verified = 0;
  const durations = [];
  for (const run of world?.find({ type: "run", limit: 500 }) ?? []) {
    if (harness && run.attrs.harness !== harness) continue;
    if (model && run.attrs.model !== model) continue;
    if (!["verified", "unverified"].includes(run.attrs.status)) continue;
    runs += 1;
    if (run.attrs.status === "verified") verified += 1;
    const minutes = (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 60_000;
    if (Number.isFinite(minutes) && minutes >= 0) durations.push(minutes);
  }
  durations.sort((a, b) => a - b);
  return {
    runs,
    verified,
    successRate: (verified + 1) / (runs + 2),
    minutes: durations.length ? durations[Math.floor(durations.length / 2)] : null,
  };
}

/**
 * Chooses among candidates within the budget.
 * @param {object[]} candidates
 * @param {{ budget?: { maxUsd?: number, maxMinutes?: number, maxRisk?: number, localOnly?: boolean }, weights?: object, prefer?: string | null }} options
 * @returns {{ chosen: object | null, ranked: object[], rejected: { id: string, reason: string }[], reasons: string[] }}
 */
export function choosePath(candidates, { budget = {}, weights = DEFAULT_WEIGHTS, prefer = null } = {}) {
  const rejected = [];
  const eligible = [];
  for (const candidate of candidates) {
    const minutes = candidate.minutes ?? UNKNOWN_MINUTES;
    const reason = budget.localOnly && candidate.privacy !== "local" ? "the work must stay on this machine"
      : budget.maxUsd !== undefined && (candidate.costUsd ?? 0) > budget.maxUsd ? `costs about $${(candidate.costUsd ?? 0).toFixed(2)}, over the $${budget.maxUsd} budget`
        : budget.maxMinutes !== undefined && candidate.minutes !== null && candidate.minutes !== undefined && minutes > budget.maxMinutes ? `usually takes ${Math.round(minutes)} min, over the ${budget.maxMinutes} min budget`
          : budget.maxRisk !== undefined && (candidate.risk ?? 0) > budget.maxRisk ? `risk ${candidate.risk} is over the allowed ${budget.maxRisk}`
            : null;
    if (reason) { rejected.push({ id: candidate.id, reason }); continue; }
    const score = candidate.successRate
      - minutes * weights.perMinute
      - (candidate.costUsd ?? 0) * weights.perDollar
      - (candidate.privacy === "remote" ? weights.remotePrivacy : 0)
      - (candidate.risk ?? 0) * weights.perRisk;
    eligible.push({ ...candidate, score });
  }
  // Highest score first; a near tie (within 0.01) goes to the preferred (configured) choice.
  eligible.sort((a, b) => (Math.abs(b.score - a.score) > 0.01 ? b.score - a.score : Number(b.id === prefer) - Number(a.id === prefer) || a.id.localeCompare(b.id)));
  const chosen = eligible[0] ?? null;
  const reasons = chosen ? [explain(chosen), ...(eligible[1] ? [`next best: ${eligible[1].id} (${explain(eligible[1])})`] : [])] : ["no candidate fits the budget"];
  return { chosen, ranked: eligible, rejected, reasons };
}

function explain(candidate) {
  const evidence = candidate.evidence?.runs
    ? `${candidate.evidence.verified} of ${candidate.evidence.runs} past runs verified${candidate.minutes !== null && candidate.minutes !== undefined ? `, about ${Math.max(1, Math.round(candidate.minutes))} min each` : ""}`
    : "no history yet";
  return `${evidence}; ${candidate.costUsd ? `about $${candidate.costUsd.toFixed(2)}` : "no cost"}, ${candidate.privacy === "local" ? "stays on this machine" : "leaves this machine"}`;
}

/** Candidates for coder work: the locally installed models, each with its own history. */
export function localModelCandidates(world, models) {
  return models.map((model) => {
    const evidence = estimateFromHistory(world, { harness: "atlas-cli", model });
    return { id: model, successRate: evidence.successRate, minutes: evidence.minutes, costUsd: 0, privacy: "local", risk: 0, evidence };
  });
}
