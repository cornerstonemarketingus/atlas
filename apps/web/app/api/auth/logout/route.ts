import { clearSessionCookieHeader, readSessionCookie, verifySession } from "../session.mjs";
import { revokeSession } from "../revocation.mjs";
import { d1RevocationStore } from "../revocation-store";

/**
 * Signs out: the cookie is cleared and the session is revoked server-side,
 * so a copied token stops working too (SEC-2). `{ "everywhere": true }`
 * revokes every session of this account issued until now.
 */
export async function POST(request: Request) {
  const headers = { "set-cookie": clearSessionCookieHeader() };
  const cookie = readSessionCookie(request);
  const payload = cookie ? await verifySession(cookie, process.env.ATLAS_SESSION_SECRET ?? "") : null;
  if (!payload) return new Response(null, { status: 204, headers });
  let everywhere = false;
  try { everywhere = ((await request.json()) as { everywhere?: unknown }).everywhere === true; } catch { /* an empty body signs out this session */ }
  try {
    const result = await revokeSession(payload, d1RevocationStore(), { everywhere });
    return Response.json({ signedOut: true, revoked: result.revoked, everywhere, ...(result.degraded ? { note: "Server-side revocation is not active yet: apply D1 migration 0014." } : {}) }, { headers });
  } catch {
    // The cookie is still cleared; say plainly that the token itself may still be valid.
    return Response.json({ signedOut: true, revoked: false, note: "Signed out on this device, but the session could not be revoked server-side. Try again." }, { status: 200, headers });
  }
}
