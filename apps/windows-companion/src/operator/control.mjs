import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Operator control: pause, resume, take over, hand back and cancel, with a
 * durable receipt for every change and a journal of consequential actions that
 * survives a crash.
 *
 * One control serves everything that operates a computer for the owner (the
 * browser session and the desktop session), so "stop" means stop everywhere.
 * It is a deterministic state machine, not a flag:
 *
 *   idle ──begin/first use──▶ running ◀──resume── paused
 *                               │  ▲                ▲
 *                     pause ────┼──┼────────────────┘
 *                    takeover   │  └── handBack ── taken_over ◀── (running, paused, blocked, interrupted)
 *                     block ────▶ blocked  (a wall only a person can pass)
 *   any ──cancel──▶ cancelled  (terminal until `begin`)
 *   restart while operating ──▶ interrupted (a person must look before Atlas acts again)
 *
 * Rules this file enforces rather than hopes for:
 *
 * - Atlas acts only while `running`. Reads stay available while paused,
 *   blocked or taken over, so the owner can see what Atlas sees.
 * - Handing control back bumps `epoch`; a page reference taken before a
 *   takeover is refused afterwards, because the person may have changed
 *   anything.
 * - Pausing and cancelling never fail: they take effect in memory first and
 *   then try to journal. Every other change, and every consequential action, is
 *   journaled first and refused if the journal cannot be written (Atlas fails
 *   closed when it cannot keep its audit trail).
 * - A consequential action is recorded as an intent before it runs and an
 *   outcome after. If the runtime stops in between, or the action throws, the
 *   intent is `uncertain`: the identical action is refused until the owner
 *   says whether it happened. Atlas never repeats a consequential action on a
 *   guess.
 * - Receipts and status carry hosts, action types and risk classes, never
 *   typed values, page text or full URLs.
 */
export class ControlError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.details = details;
  }
}

export const OPERATOR_STATES = Object.freeze(["idle", "running", "paused", "taken_over", "blocked", "interrupted", "cancelled"]);

/** action → { from: states it may start in, to: the state it ends in } */
const ACTIONS = Object.freeze({
  begin: { from: ["idle", "cancelled"], to: "running" },
  pause: { from: ["running"], to: "paused" },
  resume: { from: ["paused"], to: "running" },
  takeover: { from: ["running", "paused", "blocked", "interrupted"], to: "taken_over" },
  handBack: { from: ["taken_over"], to: "running" },
  block: { from: ["running"], to: "blocked" },
  interrupt: { from: ["running", "paused", "taken_over", "blocked"], to: "interrupted" },
  cancel: { from: ["idle", "running", "paused", "taken_over", "blocked", "interrupted"], to: "cancelled" },
});
/** Stopping things must always work, even when the audit trail cannot be written. */
const SAFETY_ACTIONS = new Set(["pause", "cancel"]);

const STOPPED_MESSAGES = Object.freeze({
  cancelled: ["OPERATOR_CANCELLED", "The owner cancelled this run. Stop acting and report what you did. Do not retry."],
  paused: ["OPERATOR_PAUSED", "The owner paused Atlas. Stop acting and wait; do not retry until the owner resumes."],
  taken_over: ["HUMAN_IN_CONTROL", "The owner has taken over the computer. Do not act; wait until control is handed back, then take a fresh snapshot."],
  blocked: ["OPERATOR_BLOCKED", "Atlas is stopped at a step only a person can complete. Do not act; wait for the owner to take over and hand back."],
  interrupted: ["OPERATOR_INTERRUPTED", "Atlas restarted while operating. The owner must check the computer and hand control back before Atlas acts again."],
});

const MAX_MILESTONES = 50;
const MAX_RECEIPTS_SERVED = 500;
const text = (value, max = 200) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);

/** Only the origin's host is ever kept: no path, query, fragment or credentials. */
export function siteOf(url) {
  try { return new URL(String(url)).host; } catch { return null; }
}

// -- journals -------------------------------------------------------------------------------------------------------

export function createMemoryJournal() {
  const entries = [];
  return { append(entry) { entries.push(structuredClone(entry)); }, load() { return entries.map((entry) => structuredClone(entry)); } };
}

/** Append-only JSON lines, owner-readable only. A torn final line (a crash mid-write) is ignored. */
export function createFileJournal(path) {
  return {
    append(entry) {
      mkdirSync(dirname(path), { recursive: true });
      const fresh = !existsSync(path);
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      if (fresh) { try { chmodSync(path, 0o600); } catch { /* best effort on platforms without modes */ } }
    },
    load() {
      if (!existsSync(path)) return [];
      const entries = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* a torn line is skipped, never trusted */ }
      }
      return entries;
    },
  };
}

// -- the control ----------------------------------------------------------------------------------------------------

export function createOperatorControl({ journal = createMemoryJournal(), audit = () => {}, now = () => Date.now() } = {}) {
  let state = "idle";
  let runId = 0;
  let seq = 0;
  let epoch = 0;
  let since = now();
  let runStartedAt = null;
  let lastActor = "system";
  let lastReason = null;
  let site = null;
  let current = null;
  let approvalPending = false;
  let inFlight = 0;
  let auditWarning = null;
  const intents = new Map();
  const milestones = [];
  const receipts = [];
  const listeners = new Set();

  const tell = (type) => {
    const snapshot = status();
    for (const listener of listeners) { try { listener({ type, status: snapshot }); } catch { /* a bad listener never stops control */ } }
  };

  function write(entry) {
    const full = { seq: seq + 1, runId, at: new Date(now()).toISOString(), ...entry };
    journal.append(full);
    seq = full.seq;
    receipts.push(full);
    if (receipts.length > 5_000) receipts.splice(0, receipts.length - 5_000);
    try { audit(`operator.${full.type}`, receiptSummary(full)); } catch { /* audit mirrors the journal; it never blocks it */ }
    return full;
  }

  /** Journal first, then change: a change that cannot be recorded does not happen. */
  function commit(entry, apply, { safety = false } = {}) {
    if (safety) {
      apply();
      try { write(entry); auditWarning = null; } catch (error) {
        auditWarning = "The audit journal could not be written; this change took effect but is not recorded.";
        void error;
      }
      return;
    }
    try { write(entry); } catch {
      throw new ControlError("AUDIT_UNAVAILABLE", "Atlas cannot write its audit trail, so it will not change what it is doing. Free disk space or fix permissions, then try again.");
    }
    apply();
  }

  function transition(action, { actor = "owner", reason = null } = {}) {
    const rule = ACTIONS[action];
    if (!rule) throw new ControlError("UNKNOWN_ACTION", `Unknown operator action '${action}'.`);
    if (state === rule.to && action !== "begin") return { changed: false, status: status() };
    if (!rule.from.includes(state)) {
      throw new ControlError("INVALID_TRANSITION", `Atlas is ${state.replace("_", " ")}, so it cannot ${action}. It can: ${Object.entries(ACTIONS).filter(([, candidate]) => candidate.from.includes(state)).map(([name]) => name).join(", ") || "nothing"}.`, { state, action });
    }
    const from = state;
    const nextRun = action === "begin" ? runId + 1 : runId;
    commit({ type: "transition", runId: nextRun, action, from, to: rule.to, actor: text(actor, 80), reason: reason ? text(reason, 200) : null }, () => {
      if (action === "begin") { runId = nextRun; runStartedAt = now(); milestones.length = 0; current = null; }
      if (action === "handBack") epoch += 1;
      state = rule.to;
      since = now();
      lastActor = text(actor, 80);
      lastReason = reason ? text(reason, 200) : null;
      if (rule.to !== "running") { approvalPending = false; current = null; }
    }, { safety: SAFETY_ACTIONS.has(action) });
    tell("state");
    return { changed: true, status: status() };
  }

  function status() {
    const open = [...intents.values()].filter((intent) => intent.status === "uncertain" || intent.status === "pending");
    return {
      runId, state, since: new Date(since).toISOString(), elapsedMs: runStartedAt === null ? 0 : now() - runStartedAt,
      lastActor, lastReason, site, currentAction: current, approvalPending, inFlight: inFlight > 0, epoch,
      milestones: milestones.slice(-10),
      uncertain: open.filter((intent) => intent.status === "uncertain").map(({ id, summary, actionClass, at }) => ({ id, summary, actionClass, at })),
      receipts: receipts.length, ...(auditWarning ? { auditWarning } : {}),
    };
  }

  // Recovery: whatever the journal says was happening when the last process stopped.
  function recover() {
    let lastState = "idle";
    for (const entry of journal.load()) {
      seq = Math.max(seq, entry.seq ?? 0);
      runId = Math.max(runId, entry.runId ?? 0);
      receipts.push(entry);
      if (entry.type === "transition") { lastState = entry.to; epoch += entry.action === "handBack" ? 1 : 0; lastActor = entry.actor ?? lastActor; lastReason = entry.reason ?? null; since = Date.parse(entry.at) || since; }
      if (entry.type === "intent") intents.set(entry.intentId, { id: entry.intentId, runId: entry.runId, digest: entry.digest, summary: entry.summary, actionClass: entry.actionClass, at: entry.at, status: "pending" });
      if (entry.type === "outcome" && intents.has(entry.intentId)) intents.get(entry.intentId).status = entry.uncertain ? "uncertain" : entry.ok ? "done" : "failed";
      if (entry.type === "ack" && intents.has(entry.intentId)) intents.get(entry.intentId).status = entry.verdict === "happened" ? "confirmed_done" : "cleared";
    }
    for (const intent of intents.values()) if (intent.status === "pending") intent.status = "uncertain";
    state = lastState;
    if (["running", "paused", "taken_over", "blocked"].includes(state)) {
      try { transition("interrupt", { actor: "system", reason: "Atlas restarted while operating." }); } catch { state = "interrupted"; }
    }
  }
  recover();

  return {
    get state() { return state; },
    get epoch() { return epoch; },
    status,
    states: OPERATOR_STATES,

    begin: (options) => transition("begin", options),
    pause: (options) => transition("pause", options),
    resume: (options) => transition("resume", options),
    takeover: (options) => transition("takeover", options),
    handBack: (options) => transition("handBack", options),
    cancel: (options) => transition("cancel", options),
    /** A wall only a person can pass (CAPTCHA, 2FA, identity check). */
    block: ({ reason }) => (state === "running" ? transition("block", { actor: "agent", reason }) : { changed: false, status: status() }),

    /**
     * Called before every operation. `kind` is "act" (changes something) or
     * "read". Throws a ControlError whose message tells the model what to do.
     */
    guard({ kind = "act" } = {}) {
      if (state === "idle") transition("begin", { actor: "agent", reason: "First operation." });
      if (state === "running") return true;
      if (kind === "read" && state !== "cancelled") return true;
      const [code, message] = STOPPED_MESSAGES[state];
      throw new ControlError(code, message, { state });
    },

    setSite(url) { site = siteOf(url) ?? site; },
    setApprovalPending(value) { approvalPending = Boolean(value); tell("approval"); },
    /** A safe milestone: what kind of step, where (host), how risky, how it ended. Never a value. */
    milestone({ kind, risk = null, outcome = "done", url = null }) {
      if (url) this.setSite(url);
      milestones.push({ at: new Date(now()).toISOString(), kind: text(kind, 40), host: site, risk: risk ? text(risk, 40) : null, outcome: text(outcome, 40) });
      if (milestones.length > MAX_MILESTONES) milestones.splice(0, milestones.length - MAX_MILESTONES);
      tell("milestone");
    },
    /** Marks an operation in progress (for the status line) and counts it, so "pause" can say it is waiting for one to finish. */
    async run(label, fn) {
      current = { type: text(label, 40) };
      inFlight += 1;
      tell("action");
      try { return await fn(); } finally { inFlight -= 1; current = null; tell("action"); }
    },

    /**
     * Records the intent to perform a consequential action, before it runs.
     * Refuses an action that may already have happened.
     */
    intent({ digest, summary, actionClass }) {
      const earlier = [...intents.values()].find((candidate) => candidate.digest === digest && (candidate.status === "uncertain" || candidate.status === "pending" || (candidate.status === "confirmed_done" && candidate.runId === runId)));
      if (earlier?.status === "confirmed_done") throw new ControlError("ACTION_ALREADY_DONE", "The owner confirmed this exact action already happened in this run. It will not be done again.", { intentId: earlier.id });
      if (earlier) throw new ControlError("ACTION_UNCERTAIN", "An earlier attempt at this exact action may have happened (Atlas stopped or errored before it could check). Do not repeat it: tell the owner, who can check and confirm whether it happened.", { intentId: earlier.id });
      if (intents.size >= 500) for (const [key, old] of intents) { if (["done", "failed", "cleared"].includes(old.status)) { intents.delete(key); if (intents.size < 400) break; } }
      const id = `intent-${runId}-${seq + 1}`;
      commit({ type: "intent", intentId: id, digest, summary: text(summary, 300), actionClass: text(actionClass, 40) }, () => {
        intents.set(id, { id, runId, digest, summary: text(summary, 300), actionClass: text(actionClass, 40), at: new Date(now()).toISOString(), status: "pending" });
      });
      tell("intent");
      return id;
    },
    /** `uncertain` for an action that threw part-way: it may have taken effect. */
    outcome({ intentId, ok, changed = null, uncertain = false }) {
      const intent = intents.get(intentId);
      if (!intent) return;
      const flagged = Boolean(uncertain);
      try {
        commit({ type: "outcome", intentId, ok: Boolean(ok), changed, uncertain: Boolean(flagged) }, () => { intent.status = flagged ? "uncertain" : ok ? "done" : "failed"; });
      } catch {
        // Could not journal the result: the intent stays pending in memory and becomes uncertain on restart.
        intent.status = "uncertain";
      }
      tell("intent");
    },
    /** The owner says whether an uncertain action happened. */
    acknowledge({ intentId, verdict, actor = "owner" }) {
      const intent = intents.get(intentId);
      if (!intent) throw new ControlError("UNKNOWN_INTENT", "There is no such recorded action.");
      if (intent.status !== "uncertain") throw new ControlError("NOT_UNCERTAIN", `This action is '${intent.status}', so there is nothing to confirm.`);
      if (!["happened", "did_not_happen"].includes(verdict)) throw new ControlError("INVALID_VERDICT", "Say whether it happened or did not happen.");
      commit({ type: "ack", intentId, verdict, actor: text(actor, 80) }, () => { intent.status = verdict === "happened" ? "confirmed_done" : "cleared"; });
      tell("intent");
      return status();
    },

    /** Receipts, newest last; bounded, and values were never put in them. */
    receipts({ after = 0, limit = 100 } = {}) {
      return receipts.filter((entry) => entry.seq > after).slice(0, Math.min(limit, MAX_RECEIPTS_SERVED)).map((entry) => structuredClone(entry));
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

function receiptSummary(entry) {
  if (entry.type === "transition") return `${entry.from} -> ${entry.to} by ${entry.actor}${entry.reason ? ` (${entry.reason})` : ""}`;
  if (entry.type === "intent") return `intent ${entry.intentId}: ${entry.summary}`;
  if (entry.type === "outcome") return `outcome ${entry.intentId}: ${entry.uncertain ? "uncertain" : entry.ok ? "done" : "failed"}`;
  return `${entry.type} ${entry.intentId ?? ""} ${entry.verdict ?? ""}`.trim();
}
