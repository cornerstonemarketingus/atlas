import { createHash, timingSafeEqual } from "node:crypto";

import { readSessionCookie, verifySession } from "../auth/session.mjs";
import { checkRevocation } from "../auth/revocation.mjs";

const BEARER_PREFIX = "Bearer ";

/**
 * Resolves the full authenticated account, including the internal D1 `users.id`
 * (`dbUserId`) that billing and usage gating key off of. `dbUserId` is null for
 * the platform-header and operator-token paths — neither is a billed GitHub
 * account, so plan gating treats them as unrestricted rather than guessing at
 * a tier for them.
 */
export async function authenticatedAccount(request, environment = process.env, { revocationStore = undefined } = {}) {
  const platformUserId = request.headers.get("oai-authenticated-user-id");
  // Only opt in behind an ingress that strips/replaces client-supplied headers.
  // Public workers.dev requests are not a trusted identity provider.
  if (environment.ATLAS_TRUST_PLATFORM_HEADERS === "true" && platformUserId
    && platformUserId !== "operator" && !platformUserId.startsWith("github:")) {
    return { userId: platformUserId, dbUserId: null };
  }

  const operatorToken = environment.ATLAS_OPERATOR_TOKEN;
  if (operatorToken) {
    const header = request.headers.get("authorization");
    if (typeof header === "string" && constantTimeEqual(header, `${BEARER_PREFIX}${operatorToken}`)) return { userId: "operator", dbUserId: null };
  }

  const sessionSecret = environment.ATLAS_SESSION_SECRET;
  if (sessionSecret) {
    const cookie = readSessionCookie(request);
    const verified = cookie ? await verifySession(cookie, sessionSecret) : null;
    const payload = verified && !(await isRevoked(verified, revocationStore)) ? verified : null;
    if (payload?.role === "operator") {
      return { userId: "operator", dbUserId: null };
    }
    if (payload && typeof payload.uid === "number" && typeof payload.gh === "string") {
      return { userId: `github:${payload.gh}`, dbUserId: payload.uid };
    }
  }

  return null;
}

/**
 * Compares secrets without leaking, through timing, how long a matching
 * prefix was. Hashing first gives both sides the same length.
 */
export function constantTimeEqual(actual, expected) {
  const a = createHash("sha256").update(String(actual ?? "")).digest();
  const b = createHash("sha256").update(String(expected ?? "")).digest();
  return timingSafeEqual(a, b);
}

/**
 * A signed-out or "signed out everywhere" session is refused server-side
 * (SEC-2). Before migration 0014 exists the check degrades to allowing the
 * session, as before; any other lookup failure refuses it, because a session
 * that cannot be checked is not trusted.
 */
async function isRevoked(payload, store) {
  let resolved = store;
  if (resolved === undefined) {
    // The D1 store only loads inside the Worker; outside it (plain Node, as in
    // unit tests) there is no database to consult, which is not a verdict.
    try { resolved = (await import("../auth/revocation-store")).d1RevocationStore(); }
    catch { return false; }
  }
  if (!resolved) return false;
  try {
    return (await checkRevocation(payload, resolved)).revoked;
  } catch {
    return true;
  }
}

export async function authenticatedUserId(request, environment = process.env) {
  const account = await authenticatedAccount(request, environment);
  return account ? account.userId : null;
}
