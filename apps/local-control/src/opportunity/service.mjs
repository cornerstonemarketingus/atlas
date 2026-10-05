import { randomUUID } from "node:crypto";

import { expectedPayout, parseGoal } from "./model.mjs";
import { OpportunityStoreError, SETTLED } from "./store.mjs";

/**
 * Goals in, ranked opportunities out, with the owner deciding what happens next.
 *
 * A hunt is one goal ("Find legitimate opportunities for me to make $500 this
 * week"). It runs as a kernel run (traced, recorded in the world state), asks
 * the scout for normalized opportunities and stores them. Everything after
 * discovery is a status change on a stored record, and every change is
 * refused unless it follows an allowed transition:
 *
 *   approve   needs the digest of the facts the owner saw (AUTO and
 *             APPROVAL_REQUIRED only; MANUAL is the owner's to do)
 *   take_over the owner does it themselves (any class)
 *   claim     what Atlas calls before it works on a record: only an approved
 *             one, or an AUTO one, and only once
 *   skip / applied / won / lost   the owner's own record of what happened
 */

const MAX_GOAL = 1000;
const OWNER_DECISIONS = Object.freeze({
  approve: { to: "approved", from: ["discovered"] },
  take_over: { to: "manual", from: ["discovered"] },
  skip: { to: "skipped", from: ["discovered", "approved", "manual", "pursuing"] },
  applied: { to: "applied", from: ["manual", "pursuing"] },
  won: { to: "won", from: ["manual", "applied"] },
  lost: { to: "lost", from: ["manual", "pursuing", "applied"] },
});
/** What Atlas itself may report about work it did; winning money is the owner's word. */
const AGENT_REPORTS = Object.freeze({ applied: "applied", lost: "lost" });

export class OpportunityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpportunityError";
    this.code = code;
  }
}

export class OpportunityService {
  #store;
  #scout;
  #kernel;
  #world;
  #audit;
  #clock;
  #running = new Map();

  /**
   * @param {{ store: import("./store.mjs").OpportunityStore, scout: Function | null, kernel?: object | null, world?: object | null, audit?: Function, clock?: () => number }} options
   *   `scout` is null when no search is configured; starting a hunt then says so.
   */
  constructor({ store, scout, kernel = null, world = null, audit = () => {}, clock = () => Date.now() }) {
    this.#store = store;
    this.#scout = scout;
    this.#kernel = kernel;
    this.#world = world;
    this.#audit = audit;
    this.#clock = clock;
  }

  #now() { return new Date(this.#clock()).toISOString(); }

  #observe(opportunity) {
    try {
      this.#world?.upsert({ type: "task", key: `opportunity:${opportunity.id}`, attrs: { title: opportunity.title.slice(0, 200), kind: "opportunity", state: opportunity.status, executionClass: opportunity.executionClass, source: opportunity.source } });
    } catch { /* the world state never stops the owner's decision */ }
  }

  // ── hunts ──────────────────────────────────────────────────────────────────

  /** Hunts a previous process left scouting are marked interrupted; nothing resumes on its own. */
  recover() {
    for (const hunt of this.#store.interruptedHunts()) this.#store.saveHunt({ ...hunt, state: "interrupted", message: "Atlas stopped while this hunt was running. Start it again; what it found is kept.", updatedAt: this.#now() });
  }

  /** Start a hunt and return at once; poll `hunt(id)` or watch the Command Center. */
  startHunt({ goal, model = null } = {}) {
    const parsed = parseGoal(typeof goal === "string" ? goal : "");
    if (!parsed.goal || parsed.goal.length > MAX_GOAL) throw new OpportunityError("INVALID_GOAL", `Describe what you want to earn (up to ${MAX_GOAL} characters).`);
    if (!this.#scout) throw new OpportunityError("NO_SEARCH", "Finding opportunities needs web search and a model. Add ATLAS_TAVILY_API_KEY to Atlas's environment, and make sure a model is available.");
    if (this.#running.size > 0) throw new OpportunityError("HUNT_RUNNING", "A hunt is already running. Wait for it to finish or cancel it.");
    const now = this.#now();
    const hunt = {
      id: `hunt-${randomUUID()}`, goal: parsed.goal, targetUsd: parsed.targetUsd, horizonDays: parsed.horizonDays,
      model: typeof model === "string" && model.trim() ? model.trim().slice(0, 200) : null,
      state: "scouting", message: null, notes: [], stats: null, runId: null, createdAt: now, updatedAt: now,
    };
    this.#store.saveHunt(hunt);
    this.#audit("opportunity.hunt", `Started: ${hunt.goal.slice(0, 120)}`);
    const controller = new AbortController();
    const done = this.#run(hunt, controller.signal);
    this.#running.set(hunt.id, { controller, done });
    done.finally(() => this.#running.delete(hunt.id));
    return hunt;
  }

  /** Resolves when a hunt finishes (tests and callers that must wait). */
  async finished(huntId) { await this.#running.get(huntId)?.done; return this.hunt(huntId); }

  cancelHunt(huntId) {
    const hunt = this.#store.hunt(huntId);
    if (!hunt) throw new OpportunityError("UNKNOWN_HUNT", "Hunt not found.");
    this.#running.get(huntId)?.controller.abort();
    return this.hunt(huntId);
  }

  async #run(hunt, signal) {
    const notes = [];
    const progress = (note) => { notes.push(note); if (notes.length <= 40) this.#store.saveHunt({ ...this.#store.hunt(hunt.id), notes: notes.slice(-12), updatedAt: this.#now() }); };
    let outcome = null;
    const harness = async () => {
      try {
        const result = await this.#scout({
          goal: hunt.goal, model: hunt.model, signal, now: this.#clock(), onProgress: progress,
          known: (key) => this.#store.byKey(key) !== null,
        });
        outcome = { ok: true, result };
        return { ok: true, summary: `${result.found.length} found from ${result.read} pages.`, artifacts: result.found.map((found) => ({ kind: "opportunity", key: found.key, attrs: { title: found.title, class: found.executionClass } })) };
      } catch (error) {
        outcome = { ok: false, error };
        return { ok: false, cancelled: signal.aborted, summary: error instanceof Error ? error.message : String(error) };
      }
    };
    const spec = { runId: `opportunity-${hunt.id}`, goal: { title: hunt.goal, doneWhen: "opportunities are found, normalized, ranked and stored" }, capabilities: ["research"], harness: "opportunity-scout", model: hunt.model, environment: { kind: "web" } };
    try {
      if (this.#kernel) {
        const { runId } = await this.#kernel.runHarness(spec, harness, { verify: () => ({ passed: true, reason: "The hunt ran to the end; what it found is stored." }) });
        this.#store.saveHunt({ ...this.#store.hunt(hunt.id), runId });
      } else await harness();
    } catch (error) {
      outcome = { ok: false, error };
    }
    this.#finishHunt(hunt.id, outcome, signal.aborted);
  }

  #finishHunt(huntId, outcome, cancelled) {
    const base = this.#store.hunt(huntId);
    const at = this.#now();
    if (!outcome?.ok) {
      const message = cancelled ? "Cancelled." : outcome?.error instanceof Error ? outcome.error.message : "The hunt failed.";
      this.#store.saveHunt({ ...base, state: cancelled ? "cancelled" : "failed", message, updatedAt: at });
      return;
    }
    const { result } = outcome;
    const stats = { queries: result.queries, searched: result.searched, read: result.read, skippedKnown: result.skippedKnown, found: result.found.length, created: 0, refreshed: 0, rejected: result.rejected.length, dropped: result.dropped.length };
    for (const found of result.found) {
      const saved = this.#store.upsert(found, { huntId, at });
      if (saved.created) stats.created += 1;
      if (saved.refreshed) stats.refreshed += 1;
      this.#observe(saved.opportunity);
    }
    // A scam is remembered by address so it is never read or ranked again.
    for (const item of result.rejected) {
      const saved = this.#store.upsert(rejectedRecord(item), { huntId, at });
      this.#observe(saved.opportunity);
    }
    this.#store.saveHunt({ ...base, state: "done", message: null, stats, dropped: result.dropped.slice(0, 20), updatedAt: at });
    this.#audit("opportunity.hunt", `${stats.created} new, ${stats.skippedKnown} already known, ${stats.rejected} rejected (${base.goal.slice(0, 80)})`);
  }

  hunt(id) {
    const hunt = this.#store.hunt(id);
    return hunt ? { ...hunt, progress: this.#progress(hunt) } : null;
  }

  hunts() { return this.#store.hunts().map((hunt) => ({ ...hunt, progress: this.#progress(hunt) })); }

  /**
   * How far the hunt's pipeline gets toward its target: pay × the chance of
   * qualifying, summed over what is still actionable. An estimate, labelled as one.
   */
  #progress(hunt) {
    const open = this.#store.list({ huntId: hunt.id }).filter((opportunity) => !SETTLED.has(opportunity.status) && opportunity.status !== "applied");
    const earned = this.#store.list({ huntId: hunt.id, status: "won" }).reduce((sum, opportunity) => sum + (opportunity.earnedUsd ?? 0), 0);
    const expectedUsd = Math.round(open.reduce((sum, opportunity) => sum + expectedPayout(opportunity), 0) * 100) / 100;
    return {
      opportunities: this.#store.list({ huntId: hunt.id }).length, open: open.length, expectedUsd, earnedUsd: earned,
      targetUsd: hunt.targetUsd,
      coverage: hunt.targetUsd ? Math.round(((expectedUsd + earned) / hunt.targetUsd) * 100) / 100 : null,
    };
  }

  // ── opportunities ──────────────────────────────────────────────────────────

  list(filter = {}) {
    this.tick();
    return this.#store.list(filter);
  }

  counts() { return this.#store.counts(); }

  get(id) {
    const opportunity = this.#store.get(id);
    return opportunity ? { ...opportunity, history: this.#store.history(id) } : null;
  }

  /** Passed deadlines expire what is still open, so an old listing is never offered. */
  tick() {
    const today = new Date(this.#clock()).toISOString().slice(0, 10);
    for (const opportunity of this.#store.list({ limit: 1000 })) {
      if (opportunity.deadline && opportunity.deadline < today && ["discovered", "approved"].includes(opportunity.status)) {
        this.#observe(this.#store.transition(opportunity.id, "expired", { at: this.#now(), reason: `The deadline (${opportunity.deadline}) passed.` }));
      }
    }
  }

  /** The owner's decision on one record. Returns the updated record. */
  decide(id, { decision, digest = null, amountUsd = null } = {}) {
    const rule = OWNER_DECISIONS[decision];
    if (!rule) throw new OpportunityError("INVALID_DECISION", `decision must be one of: ${Object.keys(OWNER_DECISIONS).join(", ")}.`);
    const current = this.#store.get(id);
    if (!current) throw new OpportunityError("UNKNOWN_OPPORTUNITY", "Opportunity not found.");
    if (!rule.from.includes(current.status)) throw new OpportunityError("INVALID_TRANSITION", `This opportunity is ${current.status}, so it cannot be marked ${decision}.`);
    if (decision === "approve") {
      if (current.executionClass === "MANUAL") throw new OpportunityError("MANUAL_ONLY", "This one needs you (see why on the record), so Atlas cannot be approved to do it. Take it over instead.");
      if (digest !== current.digest) throw new OpportunityError("DIGEST_MISMATCH", "The details changed since you looked. Review the opportunity again before approving.");
    }
    if (decision === "won" && amountUsd !== null && (!Number.isFinite(Number(amountUsd)) || Number(amountUsd) < 0 || Number(amountUsd) > 10_000_000)) throw new OpportunityError("INVALID_DECISION", "amountUsd must be a positive number.");
    const updated = this.#transition(id, rule.to, { from: rule.from, reason: `Owner: ${decision}.`, extra: decision === "won" && amountUsd !== null ? { earnedUsd: Number(amountUsd) } : {} });
    this.#audit("opportunity.decision", `${decision}: ${updated.title.slice(0, 100)}`);
    return updated;
  }

  /**
   * Called before Atlas works on a record. Only an approved record, or an AUTO
   * one, can be claimed, and only once: a second claim finds it already pursuing.
   */
  claim(id) {
    const current = this.#store.get(id);
    if (!current) throw new OpportunityError("UNKNOWN_OPPORTUNITY", "Opportunity not found.");
    const allowed = current.status === "approved" || (current.status === "discovered" && current.executionClass === "AUTO");
    if (!allowed) {
      const why = current.status === "pursuing" ? "Atlas is already working on it." : current.status === "discovered" ? "It has not been approved." : `It is ${current.status}.`;
      throw new OpportunityError("NOT_CLAIMABLE", `Atlas cannot work on this: ${why}`);
    }
    const updated = this.#transition(id, "pursuing", { reason: "Atlas started working on it." });
    this.#audit("opportunity.claim", updated.title.slice(0, 100));
    return updated;
  }

  /** Atlas reports what happened to work it was doing. It can say applied or lost, never won. */
  report(id, outcome, note = "") {
    const to = AGENT_REPORTS[outcome];
    if (!to) throw new OpportunityError("INVALID_DECISION", "Atlas can report applied or lost; only the owner can record a win.");
    const current = this.#store.get(id);
    if (current && current.status !== "pursuing") throw new OpportunityError("NOT_CLAIMABLE", "Atlas can only report on work it claimed.");
    return this.#transition(id, to, { reason: String(note).slice(0, 300) || `Atlas reported: ${outcome}.` });
  }

  #transition(id, to, { from = null, reason, extra = {} }) {
    try {
      const updated = this.#store.transition(id, to, { at: this.#now(), reason, from, extra });
      this.#observe(updated);
      return updated;
    } catch (error) {
      if (error instanceof OpportunityStoreError) throw new OpportunityError(error.code, error.message);
      throw error;
    }
  }
}

function rejectedRecord(item) {
  return {
    key: item.key, url: item.url, title: String(item.title || item.key).slice(0, 200), kind: "other", source: new URL(item.url).hostname.replace(/^www\./u, ""),
    summary: "", payoutMinUsd: null, payoutMaxUsd: null, payoutUnit: "total", estimatedHours: null, hoursAssumed: true, deadline: null,
    requirements: [], questions: [], evidence: [], nextAction: { kind: "read_only", description: "" }, flags: { manual: [], needsAccount: false, personalData: false, injection: false },
    fit: 0, modelConfidence: 0, confidence: 0, warnings: [item.reason], executionClass: "MANUAL", classReasons: [item.reason], score: null, digest: item.key,
    status: "rejected", statusReason: item.reason,
  };
}
