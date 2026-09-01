const SESSION_COOKIE_NAME = "atlas_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * A minimal signed session token: base64url(header).base64url(payload).base64url(HMAC-SHA256 signature).
 * Not a full JWT implementation — just enough of the shape to stay debuggable, with only the one
 * algorithm this code ever produces or accepts.
 */
export async function signSession(payload, secret, now = Date.now()) {
  if (!secret) throw new Error("A session secret is required to sign a session.");
  const issuedAt = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "ATLAS-SESSION" }));
  const body = base64Url(JSON.stringify({ ...payload, iat: issuedAt, exp: issuedAt + SESSION_TTL_SECONDS }));
  const unsigned = `${header}.${body}`;
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

/** Returns the verified payload, or null if the token is malformed, mis-signed, or expired. */
export async function verifySession(token, secret, now = Date.now()) {
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(signature), new TextEncoder().encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
    if (typeof payload.exp !== "number" || Math.floor(now / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookieHeader(token) {
  return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readSessionCookie(request) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() === SESSION_COOKIE_NAME) return part.slice(separatorIndex + 1).trim();
  }
  return null;
}
