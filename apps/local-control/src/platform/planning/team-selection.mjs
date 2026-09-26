import { uncoveredPermissions } from "../family/family-graph.mjs";
import { DEFAULT_HALF_LIFE_MS, DEFAULT_MIN_SAMPLES } from "./performance.mjs";

/**
 * Adaptive team selection (blueprint §13 J).
 *
 * Given the slots a task needs filled — each described by the permissions
 * (capabilities) the work requires and optionally a family and role — the
 * selector picks specialists already in the family registry:
 *
 *   1. candidates must be persistent, live and hold every required
 *      permission (glob-aware), and match the slot's family/role if named;
 *   2. only idle or authorized agents are reusable — a running agent is busy
 *      and is reported, not taken;
 *   3. among reusable candidates, verified performance decides: agents with
 *      enough verified history rank by recency-weighted verified success,
 *      agents without enough history come after them, and an agent whose
 *      verified score is below `minVerifiedScore` is not chosen at all;
 *   4. one agent fills at most one slot.
 *
 * When no existing agent fits, the selector falls back to a *proposal* for a
 * new agent. It never authorizes anything: with `propose: true` it records
 * the proposal in the registry (state 'proposed'), which the normal
 * policy-checked authorization flow must still approve.
 */

const REUSABLE_STATES = ["idle", "authorized"];

export class TeamSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TeamSelectionError";
    this.code = code;
  }
}

export class TeamSelector {
  #registry;
  #performance;
  #options;

  /**
   * @param registry an AgentFamilyRegistry
   * @param performance a PerformanceStore (optional; without it every agent is 'unknown')
   */
  constructor({ registry, performance = null, minSamples = DEFAULT_MIN_SAMPLES, halfLifeMs = DEFAULT_HALF_LIFE_MS, minVerifiedScore = 0.5, now = undefined } = {}) {
    if (!registry) throw new TeamSelectionError("INVALID_ARGUMENT", "A family registry is required.");
    this.#registry = registry;
    this.#performance = performance;
    this.#options = { minSamples, halfLifeMs, minVerifiedScore, now };
  }

  /**
   * @param input.slots [{ name, requiredPermissions: string[], family?, role? }]
   * @param input.taskKind the kind used to look up verified performance
   * @param input.propose when true, fallback proposals are recorded as 'proposed' agents (never authorized)
   * @param input.requestedBy recorded on proposals
   * @returns { complete, team: [{ slot, agentId, ... }], proposals: [...], explanation: string[] }
   */
  select({ tenantId, slots, taskKind, taskId = null, propose = false, requestedBy = "team-selector" }) {
    if (!Array.isArray(slots) || slots.length === 0) throw new TeamSelectionError("INVALID_ARGUMENT", "At least one slot is required.");
    const agents = this.#registry.listAgents(tenantId);
    // Agents with live children coordinate a subtree; they are not specialists to staff a slot with.
    const coordinators = new Set(agents.filter((a) => a.parentId && this.#registry.isLive(a)).map((a) => a.parentId));
    const taken = new Set();
    const team = [];
    const proposals = [];
    const explanation = [];

    for (const [index, raw] of slots.entries()) {
      const slot = normalizeSlot(raw, index);
      const matching = agents.filter((a) => a.persistent
        && !coordinators.has(a.id)
        && this.#registry.isLive(a)
        && (!slot.family || a.family === slot.family)
        && (!slot.role || a.role === slot.role)
        && uncoveredPermissions(slot.requiredPermissions, a.permissions).length === 0);
      const busy = matching.filter((a) => !REUSABLE_STATES.includes(a.state));
      const alreadyChosen = matching.filter((a) => REUSABLE_STATES.includes(a.state) && taken.has(a.id));
      const scored = matching
        .filter((a) => REUSABLE_STATES.includes(a.state) && !taken.has(a.id))
        .map((agent) => ({ agent, perf: this.#score(tenantId, agent.id, taskKind ?? slot.taskKind) }));
      const poor = scored.filter((c) => c.perf.sufficient && c.perf.score < this.#options.minVerifiedScore);
      const eligible = scored.filter((c) => !poor.includes(c)).sort(compareCandidates);

      const notes = [];
      if (busy.length) notes.push(`${busy.length} matching agent(s) busy: ${busy.map((a) => a.id).join(", ")}`);
      if (alreadyChosen.length) notes.push(`${alreadyChosen.length} already assigned to another slot`);
      if (poor.length) notes.push(`${poor.length} excluded for verified score below ${this.#options.minVerifiedScore}: ${poor.map((c) => `${c.agent.id}=${c.perf.score}`).join(", ")}`);

      if (eligible.length > 0) {
        const [best, ...rest] = eligible;
        taken.add(best.agent.id);
        const why = best.perf.sufficient
          ? `best verified score ${best.perf.score} over ${best.perf.samples} result(s)`
          : `no candidate has ${this.#options.minSamples}+ verified-eligible results; chose by ${best.perf.samples ? "partial history" : "reuse order"}`;
        const line = `${slot.name}: reuse ${best.agent.state} agent ${best.agent.id} (${best.agent.role}/${best.agent.family}) — ${why}`
          + (rest.length ? `; ${rest.length} other candidate(s) ranked lower` : "")
          + (notes.length ? `; ${notes.join("; ")}` : "");
        explanation.push(line);
        team.push({
          slot: slot.name, agentId: best.agent.id, role: best.agent.role, family: best.agent.family, state: best.agent.state,
          performance: best.perf, alternatives: rest.map((c) => c.agent.id), reason: line,
        });
        continue;
      }

      const proposal = this.#proposal(tenantId, agents, slot, { taskId, requestedBy, propose });
      const line = `${slot.name}: no reusable idle agent holds ${slot.requiredPermissions.join(", ") || "the required permissions"}`
        + (notes.length ? ` (${notes.join("; ")})` : "")
        + ` — proposing a new ${slot.role ?? "specialist"} agent${proposal.parentId ? ` under ${proposal.parentId}` : ""}; it needs authorization before it can run`;
      explanation.push(line);
      proposals.push({ ...proposal, reason: line });
    }
    return { complete: proposals.length === 0, team, proposals, explanation };
  }

  #score(tenantId, agentId, taskKind) {
    if (!this.#performance || !taskKind) return { agentId, samples: 0, sufficient: false, score: null, meanCostMicroUsd: null };
    return this.#performance.score(tenantId, {
      agentId, taskKind, minSamples: this.#options.minSamples, halfLifeMs: this.#options.halfLifeMs, now: this.#options.now,
    });
  }

  #proposal(tenantId, agents, slot, { taskId, requestedBy, propose }) {
    // The family head (shallowest live agent of the slot's family) that already
    // holds everything the new agent needs becomes its parent, so the subset
    // rule holds at authorization; otherwise a root that holds it.
    const covering = agents.filter((a) => this.#registry.isLive(a) && uncoveredPermissions(slot.requiredPermissions, a.permissions).length === 0);
    const byDepth = (a, b) => a.depth - b.depth || a.id.localeCompare(b.id);
    const parent = (slot.family ? covering.filter((a) => a.family === slot.family).sort(byDepth)[0] : null)
      ?? covering.filter((a) => a.parentId === null).sort(byDepth)[0] ?? null;
    const spec = {
      slot: slot.name,
      role: slot.role ?? slot.name,
      family: slot.family ?? parent?.family ?? "general",
      permissions: [...slot.requiredPermissions],
      parentId: parent?.id ?? null,
      persistent: true,
      requiresAuthorization: true,
      recorded: false,
      agentId: null,
      state: null,
    };
    if (propose) {
      const proposed = this.#registry.proposeAgent({
        tenantId, parentId: spec.parentId, role: spec.role, family: spec.family, permissions: spec.permissions,
        persistent: true, requestedBy, taskId,
      });
      spec.recorded = true;
      spec.agentId = proposed.id;
      spec.state = proposed.state; // always 'proposed': the selector never authorizes.
    }
    return spec;
  }
}

function normalizeSlot(raw, index) {
  if (!raw || typeof raw !== "object") throw new TeamSelectionError("INVALID_ARGUMENT", `Slot ${index} must be an object.`);
  const requiredPermissions = raw.requiredPermissions ?? raw.capabilities ?? [];
  if (!Array.isArray(requiredPermissions) || requiredPermissions.some((p) => typeof p !== "string" || !p)) {
    throw new TeamSelectionError("INVALID_ARGUMENT", `Slot ${index} requiredPermissions must be strings.`);
  }
  return { name: raw.name ?? raw.role ?? `slot-${index + 1}`, requiredPermissions, family: raw.family, role: raw.role, taskKind: raw.taskKind };
}

function compareCandidates(a, b) {
  if (a.perf.sufficient !== b.perf.sufficient) return a.perf.sufficient ? -1 : 1;
  if (a.perf.sufficient && a.perf.score !== b.perf.score) return b.perf.score - a.perf.score;
  // Prefer an agent that has already been working (idle) over a freshly authorized one.
  if (a.agent.state !== b.agent.state) return a.agent.state === "idle" ? -1 : 1;
  const ca = a.perf.meanCostMicroUsd ?? Number.MAX_SAFE_INTEGER;
  const cb = b.perf.meanCostMicroUsd ?? Number.MAX_SAFE_INTEGER;
  if (ca !== cb) return ca - cb;
  // Fewer spare permissions = narrower specialist.
  if (a.agent.permissions.length !== b.agent.permissions.length) return a.agent.permissions.length - b.agent.permissions.length;
  return a.agent.id.localeCompare(b.agent.id);
}
