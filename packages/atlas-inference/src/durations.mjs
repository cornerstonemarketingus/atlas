/**
 * Waits as providers write them.
 *
 * Groq and other OpenAI-compatible servers report resets as Go durations
 * ("7.66s", "340ms", "2m59.56s", "1h2m3s") in `x-ratelimit-reset-*` headers
 * and in error text ("Please try again in 2m59.56s."), and `retry-after` in
 * whole or fractional seconds. A reader that only understands "N.Ns" misses
 * every wait over a minute and every sub-second one.
 */

const UNIT_MS = Object.freeze({ h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 0.001, "µs": 0.001, ns: 0.000_001 });
const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|us|µs|ns|h|m|s))+$/u;
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/gu;
const SUGGESTED_WAIT = /try again in ((?:\d+(?:\.\d+)?(?:ms|us|µs|ns|h|m|s))+)/iu;

/** Milliseconds in a Go-style duration, or null if the text is not one. */
export function parseDurationMs(text) {
  const trimmed = String(text ?? "").trim();
  if (!DURATION.test(trimmed)) return null;
  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(DURATION_PART)) total += Number(amount) * UNIT_MS[unit];
  return Number.isFinite(total) ? Math.ceil(total) : null;
}

/** The wait an error body names ("Please try again in 21.645s."), or null. */
export function suggestedWaitMs(body) {
  const match = SUGGESTED_WAIT.exec(String(body ?? ""));
  return match ? parseDurationMs(match[1]) : null;
}

/** `retry-after` as delta-seconds or an HTTP date. Past dates allow immediate recovery. */
export function retryAfterHeaderMs(headers, now = Date.now()) {
  const value = headerValue(headers, "retry-after").trim();
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const ms = Math.ceil(Number(value) * 1000);
    return Number.isSafeInteger(ms) ? ms : null;
  }
  // Avoid Date.parse's permissive interpretation of malformed numeric delays.
  if (!/^[A-Za-z]{3},?\s/u.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Reads a header from a Headers object or a plain record, case-insensitively. */
export function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? "";
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? "" : String(headers[key] ?? "");
}
