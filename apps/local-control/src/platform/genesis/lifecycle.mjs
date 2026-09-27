/**
 * The Project Genesis lifecycle: idea → working, verified local application.
 *
 * Every state change is an explicit, durable transition with a reason and
 * evidence (see store.mjs); this table is the only authority on which moves
 * are legal, so the orchestrator cannot "skip" verification by jumping from
 * building straight to ready.
 *
 *   idea → requirements → planned → approved → scaffolding → building
 *        → verifying → previewing → reviewing → ready → publishing → published
 *
 * with repairing as the loop back from any failed check (verifying,
 * previewing, reviewing), and paused / blocked / failed / cancelled available
 * from every active state. A finished project stays conversational: ready and
 * published go back to requirements when the owner asks for a change.
 */

export const GENESIS_STATES = Object.freeze([
  "idea", "requirements", "planned", "approved", "scaffolding", "building", "verifying",
  "previewing", "repairing", "reviewing", "ready", "publishing", "published",
  "paused", "blocked", "failed", "cancelled",
]);

/** States in which Atlas is doing work right now (a restart interrupts them). */
export const ACTIVE_STATES = Object.freeze(["scaffolding", "building", "verifying", "previewing", "repairing", "reviewing", "publishing"]);

/** Interruptions: they remember where to go back to. */
export const HOLD_STATES = Object.freeze(["paused", "blocked"]);

export const TERMINAL_STATES = Object.freeze(["cancelled"]);

const FORWARD = Object.freeze({
  idea: ["requirements"],
  requirements: ["planned", "requirements"],
  planned: ["approved", "requirements"],
  approved: ["scaffolding"],
  scaffolding: ["building"],
  building: ["verifying"],
  verifying: ["previewing", "repairing"],
  repairing: ["verifying", "building"],
  previewing: ["reviewing", "repairing"],
  reviewing: ["ready", "repairing"],
  ready: ["publishing", "requirements", "building"],
  publishing: ["published", "ready"],
  published: ["requirements", "publishing"],
  failed: ["requirements", "planned", "building"],
});

export class GenesisTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GenesisTransitionError";
    this.code = code;
  }
}

/**
 * Whether `from → to` is legal. `resumeTo` is the state a hold (paused or
 * blocked) returns to; a hold may only resume to where it was interrupted,
 * or be cancelled/failed.
 */
export function canTransition(from, to, { resumeTo = null } = {}) {
  if (!GENESIS_STATES.includes(from) || !GENESIS_STATES.includes(to)) return false;
  if (TERMINAL_STATES.includes(from)) return false;
  if (to === "cancelled") return true;
  if (HOLD_STATES.includes(from)) {
    if (to === "failed" || (HOLD_STATES.includes(to) && to !== from)) return true;
    return to === resumeTo;
  }
  if (HOLD_STATES.includes(to) || to === "failed") return from !== "failed";
  return (FORWARD[from] ?? []).includes(to);
}

export function assertTransition(from, to, options = {}) {
  if (!canTransition(from, to, options)) {
    throw new GenesisTransitionError("ILLEGAL_TRANSITION", `A Genesis project cannot move from ${from} to ${to}${HOLD_STATES.includes(from) && options.resumeTo ? ` (it resumes to ${options.resumeTo})` : ""}.`);
  }
}

/** Plain-language progress labels for the owner (no internal jargon). */
export const STATE_LABELS = Object.freeze({
  idea: "Understanding your idea",
  requirements: "Writing the requirements",
  planned: "Plan ready",
  approved: "Plan approved",
  scaffolding: "Creating the project",
  building: "Building",
  verifying: "Testing the application",
  previewing: "Opening the application",
  repairing: "Fixing a problem",
  reviewing: "Reviewing the interface",
  ready: "Ready",
  publishing: "Publishing",
  published: "Published",
  paused: "Paused",
  blocked: "Waiting for you",
  failed: "Stopped",
  cancelled: "Cancelled",
});
