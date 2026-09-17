import { verify } from "node:crypto";

export function verifyOfflineLicense(document, publicKey, now = new Date()) {
  if (!document || typeof document.payload !== "string" || typeof document.signature !== "string") return { valid: false, reason: "malformed" };
  let payload;
  try { payload = JSON.parse(Buffer.from(document.payload, "base64url").toString("utf8")); }
  catch { return { valid: false, reason: "malformed" }; }
  const authentic = verify(null, Buffer.from(document.payload), publicKey, Buffer.from(document.signature, "base64url"));
  if (!authentic) return { valid: false, reason: "invalid-signature" };
  if (!payload.licenseId || !payload.tier || !payload.expiresAt) return { valid: false, reason: "malformed" };
  if (Date.parse(payload.expiresAt) <= now.getTime()) return { valid: false, reason: "expired", claims: payload };
  return { valid: true, claims: payload };
}
