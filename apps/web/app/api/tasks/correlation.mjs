/**
 * Correlation ids tie one objective's dispatch, workflow run, pull request and
 * result callback together. Format mirrors the shared contract in
 * packages/atlas-contracts (`cor_` + 32 lowercase hex), duplicated here on
 * purpose: the web app ships as a Cloudflare Worker bundle and does not import
 * that package. Uses globalThis.crypto only, so it runs in the Worker runtime.
 */
export const CORRELATION_HEADER = "x-atlas-correlation-id";
export const CORRELATION_ID_PATTERN = /^cor_[0-9a-f]{32}$/;

export function isCorrelationId(value) {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value);
}

export function newCorrelationId() {
  return `cor_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Accepts an externally supplied id only when it is exactly the shape Atlas
 * issues; anything else (absent, malformed, oversized, log-injection attempts)
 * is replaced with a fresh id rather than rejected.
 */
export function acceptCorrelationId(candidate) {
  return isCorrelationId(candidate) ? candidate : newCorrelationId();
}

/** Reads the correlation header off a Request/Headers-like object. */
export function correlationIdFromRequest(request) {
  let candidate = null;
  try { candidate = request?.headers?.get?.(CORRELATION_HEADER) ?? null; } catch { candidate = null; }
  return acceptCorrelationId(candidate);
}
