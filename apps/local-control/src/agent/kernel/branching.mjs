/**
 * Branching: the kernel decides when one objective should be tried as
 * several competing strategies instead of one, and ranks the results.
 *
 * The decision is explicit and explainable, not a model's whim:
 *
 * - Open-ended work (redesign, refactor, migrate, upgrade, "best way",
 *   alternatives, performance) benefits from independent attempts: branch.
 * - The same objective already failed on this repository (the world state
 *   has an unverified run for it): a second single attempt is likely to
 *   repeat the failure, so branch.
 * - Small mechanical work (typo, rename, bump a version, a one-line fix)
 *   does not: one lane.
 *
 * Versions are built independently (each in its own worktree, none sees
 * another's work), which is what makes comparing them worth the cost.
 * Ranking only recommends; applying a version still goes through the owner's
 * approval.
 */
export const DEFAULT_BRANCHES = 3;

const OPEN_ENDED = /\b(re-?design|refactor|re-?architect|restructure|migrat\w*|upgrade|modernize|rewrite|optimi[sz]e|performance|faster|speed up|best (way|approach)|approach(es)?|alternatives?|options?|explore|experiment|prototype|improve)\b/iu;
const MECHANICAL = /\b(typo|rename|bump|version number|comment|lint|format(ting)?|one[- ]line|whitespace|spelling|changelog|readme)\b/iu;

/**
 * @param {{ objective: string, repository?: string | null, world?: object | null, branches?: number }} input
 * @returns {{ branch: boolean, variants: number, reasons: string[] }}
 */
export function decideStrategy({ objective, repository = null, world = null, branches = DEFAULT_BRANCHES }) {
  const text = String(objective ?? "");
  const reasons = [];
  let score = 0;
  if (OPEN_ENDED.test(text)) { score += 2; reasons.push("open-ended work: independent attempts find different solutions"); }
  const failures = earlierFailures(world, text, repository);
  if (failures) { score += 2; reasons.push(`this objective already failed ${failures === 1 ? "once" : `${failures} times`} here`); }
  if (MECHANICAL.test(text) && !failures) { score -= 3; reasons.push("small mechanical change: one attempt is enough"); }
  if (text.length > 400) { score += 1; reasons.push("a large objective"); }
  const branch = score >= 2;
  if (!reasons.length) reasons.push("a focused task: one attempt");
  return { branch, variants: branch ? branches : 1, reasons };
}

/** How many earlier runs with this goal ended unverified (optionally on this repository). */
function earlierFailures(world, objective, repository) {
  if (!world) return 0;
  const goal = objective.trim().slice(0, 500);
  let count = 0;
  for (const run of world.find({ type: "run", limit: 200 })) {
    if (run.attrs.status !== "unverified" || String(run.attrs.goal ?? "").trim() !== goal) continue;
    if (repository && !world.relations(run.id).some((edge) => edge.relation === "uses" && edge.to === `repository:${repository}`)) continue;
    count += 1;
  }
  return count;
}

/**
 * Ranks finished versions of one objective. Only versions that completed and
 * produced a patch can be recommended; among those, the smallest change
 * wins (the least to review and the least that can break), and a version
 * whose kernel run was verified beats one that was not.
 *
 * @param {object[]} lanes  command-center lanes (state, result.patch, bytes, verified)
 * @returns {{ ranked: { id: string, rank: number, reason: string }[], recommended: string | null }}
 */
export function rankVersions(lanes) {
  const candidates = lanes
    .filter((lane) => lane.state === "completed" && lane.result?.patch)
    .map((lane) => ({ id: lane.id, bytes: Number(lane.result.bytes ?? Infinity), verified: lane.verified !== false }));
  candidates.sort((a, b) => Number(b.verified) - Number(a.verified) || a.bytes - b.bytes || a.id.localeCompare(b.id));
  const ranked = candidates.map((candidate, index) => ({
    id: candidate.id,
    rank: index + 1,
    reason: index === 0
      ? candidates.length === 1 ? "the only version that finished with a change" : `smallest change among ${candidates.length} finished versions${Number.isFinite(candidate.bytes) ? ` (${candidate.bytes} bytes)` : ""}`
      : `rank ${index + 1} of ${candidates.length}`,
  }));
  return { ranked, recommended: ranked[0]?.id ?? null };
}
