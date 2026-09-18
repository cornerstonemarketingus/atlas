/**
 * Server-side quotas for hosted execution.
 *
 * "Server-side" is the whole point. A limit enforced in the client is a
 * suggestion: the client is the thing being metered, and anyone who can open
 * developer tools can raise their own ceiling. So every check here happens
 * where the session is actually created, and the client is only ever told the
 * answer.
 */
export const PLANS = {
  free: { hostedBrowser: false, concurrentSessions: 0, minutesPerMonth: 0, sessionMinutes: 0 },
  pro: { hostedBrowser: true, concurrentSessions: 1, minutesPerMonth: 300, sessionMinutes: 15 },
  team: { hostedBrowser: true, concurrentSessions: 5, minutesPerMonth: 2_000, sessionMinutes: 30 },
};

export class QuotaError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "QuotaError";
    this.code = code;
    this.detail = detail;
  }
}

export function createQuotaLedger({ now = () => Date.now(), plans = PLANS } = {}) {
  /** tenantId -> { minutesUsed, periodStart, active: Map<sessionId, startedAtMs> } */
  const tenants = new Map();

  function record(tenantId) {
    const existing = tenants.get(tenantId);
    const period = periodOf(now());
    if (!existing || existing.periodStart !== period) {
      const fresh = { minutesUsed: 0, periodStart: period, active: new Map(), receipts: [] };
      tenants.set(tenantId, fresh);
      return fresh;
    }
    return existing;
  }

  return {
    planFor(planName) { return plans[planName] ?? plans.free; },

    /**
     * Decides whether this tenant may open a hosted session right now.
     * Returns rather than throws for plan gating, because "upgrade to use
     * this" is an answer the product gives, not an error.
     */
    check({ tenantId, plan }) {
      const limits = plans[plan] ?? plans.free;
      if (!limits.hostedBrowser) {
        return {
          allowed: false,
          code: "PLAN_REQUIRED",
          message: "Hosted browser sessions are part of a paid plan. Your own Windows companion runs browser tasks on this machine at no extra cost.",
          limits,
        };
      }
      const state = record(tenantId);
      if (state.active.size >= limits.concurrentSessions) {
        return {
          allowed: false,
          code: "CONCURRENCY_REACHED",
          message: `Your plan allows ${limits.concurrentSessions} hosted browser session${limits.concurrentSessions === 1 ? "" : "s"} at a time. Finish or cancel one first.`,
          limits,
        };
      }
      if (state.minutesUsed >= limits.minutesPerMonth) {
        return {
          allowed: false,
          code: "QUOTA_EXHAUSTED",
          message: `You have used all ${limits.minutesPerMonth} hosted browser minutes for this period. Your Windows companion is unaffected.`,
          limits,
          minutesUsed: state.minutesUsed,
        };
      }
      return { allowed: true, limits, remainingMinutes: limits.minutesPerMonth - state.minutesUsed };
    },

    open({ tenantId, plan, sessionId }) {
      const decision = this.check({ tenantId, plan });
      if (!decision.allowed) throw new QuotaError(decision.code, decision.message, decision);
      const state = record(tenantId);
      state.active.set(sessionId, now());
      return { sessionId, expiresAtMs: now() + decision.limits.sessionMinutes * 60_000, limits: decision.limits };
    },

    /** Closing produces the receipt that billing is computed from. */
    close({ tenantId, sessionId, reason = "completed" }) {
      const state = record(tenantId);
      const startedAtMs = state.active.get(sessionId);
      if (startedAtMs === undefined) return null;
      state.active.delete(sessionId);
      // Rounded up: a nine-second session still consumed a slot and a
      // container, and billing per-second would be a fiction.
      const minutes = Math.max(1, Math.ceil((now() - startedAtMs) / 60_000));
      state.minutesUsed += minutes;
      const receipt = {
        tenantId,
        sessionId,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(now()).toISOString(),
        minutes,
        reason,
        periodStart: state.periodStart,
      };
      state.receipts.push(receipt);
      return receipt;
    },

    usage(tenantId) {
      const state = record(tenantId);
      return { minutesUsed: state.minutesUsed, activeSessions: state.active.size, periodStart: state.periodStart };
    },
    receipts(tenantId) { return [...record(tenantId).receipts]; },
    /** Sessions past their window, for the sweeper that closes them. */
    expired({ tenantId, plan }) {
      const limits = plans[plan] ?? plans.free;
      const state = record(tenantId);
      const deadline = now() - limits.sessionMinutes * 60_000;
      return [...state.active.entries()].filter(([, startedAtMs]) => startedAtMs <= deadline).map(([sessionId]) => sessionId);
    },
  };
}

function periodOf(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
