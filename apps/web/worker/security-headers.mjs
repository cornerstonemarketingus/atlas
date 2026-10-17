/**
 * Security headers for every response the Worker returns (SECURITY-REVIEW
 * SEC-13). Script CSP is shipping in report-only mode first, with per-request
 * nonces injected by the Worker for every script tag in rendered HTML.
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

export function createScriptNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCodePoint(...bytes));
}

export function buildScriptCspReportOnly(nonce) {
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; connect-src 'self'; style-src-attr 'unsafe-inline'; object-src 'none'; base-uri 'none'`;
}

/** Returns a response carrying the security headers; existing values win. */
export function withSecurityHeaders(response, { scriptNonce } = {}) {
  let headers;
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!response.headers.has(name)) response.headers.set(name, value);
    if (scriptNonce && !response.headers.has("content-security-policy-report-only")) {
      response.headers.set("content-security-policy-report-only", buildScriptCspReportOnly(scriptNonce));
    }
    return response;
  } catch {
    // Some responses (e.g. from fetch) have immutable headers; copy them.
    headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
    if (scriptNonce && !headers.has("content-security-policy-report-only")) {
      headers.set("content-security-policy-report-only", buildScriptCspReportOnly(scriptNonce));
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
