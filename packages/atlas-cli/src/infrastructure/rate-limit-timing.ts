/**
 * Reading how long a rate-limited provider wants us to wait.
 *
 * Groq reports waits as Go durations — "7.66s", "340ms", "2m59.56s",
 * "1h2m3s" — in `x-ratelimit-reset-*` headers and in the 429 body ("Please
 * try again in 2m59.56s."), and sends `retry-after` in whole seconds. A parser
 * that only understands "N.Ns" misses every wait over a minute and every
 * sub-second one, and the caller then retries on a guess that is certain to
 * fail again.
 */

const UNIT_MS: Readonly<Record<string, number>> = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
  us: 0.001,
  "µs": 0.001,
  ns: 0.000_001,
};

const DURATION_PATTERN = /^(?:\d+(?:\.\d+)?(?:ms|us|µs|ns|h|m|s))+$/u;
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/gu;
const SUGGESTED_WAIT = /try again in ((?:\d+(?:\.\d+)?(?:ms|us|µs|ns|h|m|s))+)/iu;

/** Milliseconds in a Go-style duration ("2m59.56s"), or undefined if it is not one. */
export function parseDurationMs(text: string): number | undefined {
  const trimmed = text.trim();
  if (!DURATION_PATTERN.test(trimmed)) return undefined;
  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(DURATION_PART)) {
    total += Number.parseFloat(amount!) * UNIT_MS[unit!]!;
  }
  return Number.isFinite(total) ? Math.ceil(total) : undefined;
}

/** The wait a provider's error text names, e.g. "Please try again in 21.645s." */
export function suggestedWaitFromMessage(message: string): number | undefined {
  const match = SUGGESTED_WAIT.exec(message);
  return match?.[1] === undefined ? undefined : parseDurationMs(match[1]);
}

/** `retry-after` as delta-seconds (the HTTP-date form is not used by model APIs). */
export function retryAfterHeaderMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (value === undefined || !/^\d+(?:\.\d+)?$/u.test(value)) return undefined;
  return Math.ceil(Number.parseFloat(value) * 1000);
}
