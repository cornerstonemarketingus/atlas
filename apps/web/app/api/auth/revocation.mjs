/**
 * Server-side session revocation (SECURITY-REVIEW SEC-2).
 *
 * Sessions are signed tokens, so signing out used to only delete the cookie:
 * a copied token kept working for 30 days. Now a session can be revoked by
 * its id, and a principal can revoke every session issued before a moment
 * ("sign out everywhere").
 *
 * The store is injected so the decision is testable without D1. If the
 * revocation tables do not exist yet (migration 0014 not applied), checks
 * degrade to today's behaviour instead of locking everyone out; the degraded
 * state is reported so it can be surfaced in setup status.
 */

/** Which principal a verified session payload speaks for. */
export function sessionPrincipal(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.gh === "string" && payload.gh) return `github:${payload.gh}`;
  if (payload.role === "operator") return "operator";
  return null;
}

const missingTable = (error) => /no such table/iu.test(String(error?.message ?? error) + String(error?.cause?.message ?? ""));

/**
 * @param {object} payload a verified session payload
 * @param {{ isSidRevoked(sid: string): Promise<boolean>, revokedBefore(principal: string): Promise<number|null> }} store
 * @returns {Promise<{ revoked: boolean, degraded: boolean }>}
 */
export async function checkRevocation(payload, store) {
  try {
    if (typeof payload.sid === "string" && await store.isSidRevoked(payload.sid)) return { revoked: true, degraded: false };
    const principal = sessionPrincipal(payload);
    const cutoff = principal ? await store.revokedBefore(principal) : null;
    // Sessions issued before the cut-off are revoked; so are old tokens without an id.
    if (cutoff !== null && typeof payload.iat === "number" && payload.iat <= cutoff) return { revoked: true, degraded: false };
    return { revoked: false, degraded: false };
  } catch (error) {
    if (missingTable(error)) return { revoked: false, degraded: true };
    throw error;
  }
}

/** Revokes one session, or every session of its principal when `everywhere`. */
export async function revokeSession(payload, store, { everywhere = false, now = Date.now() } = {}) {
  const principal = sessionPrincipal(payload) ?? "unknown";
  try {
    if (typeof payload.sid === "string") await store.revokeSid({ sid: payload.sid, principal, expiresAt: new Date((payload.exp ?? 0) * 1000).toISOString(), now });
    if (everywhere && principal !== "unknown") await store.revokeAll({ principal, before: Math.floor(now / 1000), now });
    return { revoked: true, degraded: false };
  } catch (error) {
    if (missingTable(error)) return { revoked: false, degraded: true };
    throw error;
  }
}
