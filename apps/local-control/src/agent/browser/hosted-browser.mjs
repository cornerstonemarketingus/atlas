import { createQuotaLedger, QuotaError } from "./quota.mjs";

/**
 * Hosted browser execution, as an optional adapter.
 *
 * Nothing in Atlas requires this. It exists for the case where the operator's
 * machine is asleep, and it is deliberately built so that the honest answer
 * for most people is "use your own companion, it is free and it is already
 * running".
 *
 * Tenant isolation is the security property that matters. A hosted session is
 * addressed by an opaque handle that only its owning tenant can resolve;
 * there is no path from a session id to another tenant's session, and the
 * lookup does not distinguish "does not exist" from "belongs to someone else"
 * — that distinction is itself an enumeration oracle.
 */
export class HostedBrowserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostedBrowserError";
    this.code = code;
  }
}

export function createHostedBrowserService({ provider, quotas = createQuotaLedger(), now = () => Date.now(), localCompanionAvailable = () => false }) {
  /**
   * Keyed by tenant AND session id, so ids cannot collide across tenants at
   * all. A single global namespace meant one tenant could discover another's
   * session ids through `SESSION_EXISTS`, and made the sweep collision below
   * possible in the first place.
   */
  const sessions = new Map();
  const keyFor = (tenantId, sessionId) => `${tenantId}\u0000${sessionId}`;

  /**
   * A usable tenant identity. Without this check, a caller that forgot to
   * pass a tenant matched a session opened by another caller that also forgot
   * — `undefined === undefined` is true, so the isolation check passed and
   * two unrelated callers shared a browser. Isolation must not depend on
   * every caller remembering.
   */
  function requireTenant(tenantId) {
    const usable = (typeof tenantId === "string" && tenantId.length > 0) || (typeof tenantId === "number" && Number.isFinite(tenantId));
    if (!usable) throw new HostedBrowserError("NO_TENANT", "A hosted browser session must name the tenant it belongs to.");
    return String(tenantId);
  }

  function resolve(sessionId, tenantId) {
    const owner = requireTenant(tenantId);
    const session = sessions.get(keyFor(owner, sessionId));
    // One message for both cases, on purpose: distinguishing "not yours" from
    // "does not exist" is an enumeration oracle.
    if (!session || session.tenantId !== owner) {
      throw new HostedBrowserError("NO_SUCH_SESSION", "No hosted session with that identifier is available to you.");
    }
    return session;
  }

  return {
    /**
     * Free users get a clear answer, not a failure — and where the operator's
     * own companion is available, that is offered instead of an upsell.
     */
    async open({ tenantId, plan, sessionId, signal }) {
      if (!provider) throw new HostedBrowserError("NOT_CONFIGURED", "Hosted browser execution is not configured on this Atlas.");
      const owner = requireTenant(tenantId);
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new HostedBrowserError("NO_SESSION_ID", "A hosted browser session must have an identifier.");
      }
      // Scoped to this tenant, so the answer says nothing about anybody else's
      // sessions. Checking a global namespace made this a free existence
      // oracle for a caller not even entitled to the feature.
      if (sessions.has(keyFor(owner, sessionId))) throw new HostedBrowserError("SESSION_EXISTS", "You already have a session with that identifier.");
      const decision = quotas.check({ tenantId: owner, plan });
      if (!decision.allowed) {
        return {
          opened: false,
          code: decision.code,
          message: localCompanionAvailable({ tenantId: owner })
            ? `${decision.message} Atlas will run this on your paired companion instead.`
            : decision.message,
          fallback: localCompanionAvailable({ tenantId: owner }) ? "windows-companion" : null,
          limits: decision.limits,
        };
      }

      const lease = quotas.open({ tenantId: owner, plan, sessionId });
      let page;
      try {
        // The provider is handed a tenant scope and nothing else. No credential
        // of the operator's travels in a task payload.
        page = await provider.createPage({ tenantScope: scopeFor(owner), signal });
      } catch (error) {
        // The slot was reserved before the page existed; without this the
        // reservation leaked permanently and the tenant was stuck at its
        // concurrency limit until the next billing period.
        quotas.close({ tenantId: owner, sessionId, reason: "failed-to-open" });
        throw error;
      }
      sessions.set(keyFor(owner, sessionId), { tenantId: owner, page, expiresAtMs: lease.expiresAtMs });
      return { opened: true, sessionId, expiresAtMs: lease.expiresAtMs, limits: lease.limits };
    },

    /** The page, for a caller that already proved it owns the session. */
    page({ sessionId, tenantId }) {
      const session = resolve(sessionId, tenantId);
      if (session.expiresAtMs <= now()) throw new HostedBrowserError("SESSION_EXPIRED", "That hosted session has reached its time limit and was closed.");
      return session.page;
    },

    async close({ sessionId, tenantId, reason = "completed" }) {
      const session = resolve(sessionId, tenantId);
      sessions.delete(keyFor(session.tenantId, sessionId));
      await session.page.close?.().catch(() => {});
      return quotas.close({ tenantId: session.tenantId, sessionId, reason });
    },

    /** Cancellation closes the remote container, not just the local handle. */
    async cancel({ sessionId, tenantId }) {
      return this.close({ sessionId, tenantId, reason: "cancelled" });
    },

    /**
     * Closes sessions past their window. Run on a timer: a container left
     * open bills the operator for time nobody is using.
     */
    async sweep({ tenantId, plan }) {
      const owner = requireTenant(tenantId);
      const closed = [];
      for (const sessionId of quotas.expired({ tenantId: owner, plan })) {
        // Tenant-scoped, like every other lookup. This was the one path that
        // skipped `resolve()`, so a sweep could close another tenant's live
        // session and be handed their billing receipt.
        const session = sessions.get(keyFor(owner, sessionId));
        if (session) {
          sessions.delete(keyFor(owner, sessionId));
          await session.page.close?.().catch(() => {});
        }
        // Closed in the ledger either way, so a reservation with no page
        // behind it is released rather than leaking.
        const receipt = quotas.close({ tenantId: owner, sessionId, reason: session ? "timed-out" : "abandoned" });
        if (receipt) closed.push(receipt);
      }
      return closed;
    },

    usage: (tenantId) => quotas.usage(tenantId),
    receipts: (tenantId) => quotas.receipts(tenantId),
  };
}

/** An opaque per-tenant scope; the provider never sees a user identifier. */
function scopeFor(tenantId) {
  return `tenant-${Buffer.from(String(tenantId)).toString("base64url").slice(0, 32)}`;
}

export { QuotaError };
