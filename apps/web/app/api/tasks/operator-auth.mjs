import { readSessionCookie, verifySession } from "../auth/session.mjs";

const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time secret comparison that works in a Worker (no node:crypto
 * timingSafeEqual). Both sides are hashed first, so the XOR loop always runs
 * over 32 bytes and neither the secret's length nor the position of the first
 * differing byte shows up in the timing.
 */
export async function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < x.length; index += 1) difference |= x[index] ^ y[index];
  return difference === 0;
}

/**
 * Resolves the full authenticated account, including the internal D1 `users.id`
 * (`dbUserId`) that billing and usage gating key off of. `dbUserId` is null for
 * the platform-header and operator-token paths — neither is a billed GitHub
 * account, so plan gating treats them as unrestricted rather than guessing at
 * a tier for them.
 */
export async function authenticatedAccount(request, environment = process.env) {
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
    if (header && header.startsWith(BEARER_PREFIX) && await constantTimeEqual(header.slice(BEARER_PREFIX.length), operatorToken)) {
      return { userId: "operator", dbUserId: null };
    }
  }

  const sessionSecret = environment.ATLAS_SESSION_SECRET;
  if (sessionSecret) {
    const cookie = readSessionCookie(request);
    const payload = cookie ? await verifySession(cookie, sessionSecret) : null;
    if (payload?.role === "operator") {
      return { userId: "operator", dbUserId: null };
    }
    if (payload && typeof payload.uid === "number" && typeof payload.gh === "string") {
      return { userId: `github:${payload.gh}`, dbUserId: payload.uid };
    }
  }

  return null;
}

export async function authenticatedUserId(request, environment = process.env) {
  const account = await authenticatedAccount(request, environment);
  return account ? account.userId : null;
}
