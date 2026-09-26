/**
 * Security headers for every response the Worker returns (SECURITY-REVIEW
 * SEC-13). These are the ones that cannot break a page: they stop Atlas from
 * being framed (clickjacking an approval button), stop MIME sniffing, keep
 * full URLs out of Referer headers, pin HTTPS, and switch off browser
 * features Atlas never uses. A script-source CSP is deliberately not set here:
 * the framework streams inline scripts, and a policy that breaks sign-in is
 * worse than none — that needs nonces from the renderer first.
 */
export const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
});

/** Returns a response carrying the security headers; existing values win. */
export function withSecurityHeaders(response) {
  let headers;
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!response.headers.has(name)) response.headers.set(name, value);
    return response;
  } catch {
    // Some responses (e.g. from fetch) have immutable headers; copy them.
    headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
