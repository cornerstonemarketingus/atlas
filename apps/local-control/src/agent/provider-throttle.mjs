/**
 * Provider rate limits are a scheduling signal, not a failure.
 *
 * When a model provider answers "429 / usage limit, resets at 6:10am", every
 * child agent launched into that window fails the same way, and a mission
 * that treats those failures as final throws away work that would succeed an
 * hour later. Atlas instead runs children in small batches, and when a
 * provider pushes back it:
 *
 *   1. requeues the child that hit the limit (it did not fail),
 *   2. halves the batch size (never below one), and
 *   3. launches nothing new until the provider's reset time,
 *
 * then grows the batch back by one after a run of clean completions. This is
 * additive-increase / multiplicative-decrease: the same shape TCP uses to find
 * the throughput a shared link can sustain without collapsing.
 */

export const DEFAULT_BATCH_SIZE = 3;
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_RESET_HORIZON_MS = 7 * 24 * 60 * 60_000;

const RATE_LIMIT_CODES = new Set(["RATE_LIMITED", "RATE_LIMIT", "RATE_LIMIT_EXCEEDED", "TOO_MANY_REQUESTS", "QUOTA_EXCEEDED", "USAGE_LIMIT"]);
const RATE_LIMIT_TEXT = /\b(?:429|rate[ _-]?limit(?:ed)?|too many requests|usage limit|session limit|weekly limit|quota exceeded|overloaded)\b/iu;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Decides whether an error or a failed child result is a provider rate limit,
 * and when it is safe to try again. Returns `{ rateLimited: false }` or
 * `{ rateLimited: true, retryAt, source }` where `retryAt` is epoch ms.
 *
 * The reset time is taken, in order, from an explicit `retryAt`, a
 * `retryAfterSeconds` / `retry-after` header, or a "resets 6:10am (UTC)" /
 * "resets Sep 25, 6pm (UTC)" phrase in the message; failing all of those, a
 * backoff that doubles with each consecutive limit.
 */
export function classifyRateLimit(failure, { now = Date.now(), consecutive = 0 } = {}) {
  if (!failure || typeof failure !== "object") {
    if (typeof failure !== "string") return { rateLimited: false };
    failure = { message: failure };
  }
  const code = String(failure.code ?? failure.error?.code ?? "").toUpperCase();
  const status = Number(failure.status ?? failure.statusCode ?? failure.error?.status);
  const text = [failure.message, failure.summary, failure.error?.message, failure.type, failure.error?.type]
    .filter((part) => typeof part === "string")
    .join(" ");
  const limited = status === 429 || RATE_LIMIT_CODES.has(code) || RATE_LIMIT_TEXT.test(text);
  if (!limited) return { rateLimited: false };

  const explicit = Number(failure.retryAt);
  if (Number.isFinite(explicit) && explicit > now) return { rateLimited: true, retryAt: explicit, source: "retryAt" };

  const header = failure.headers?.["retry-after"] ?? failure.headers?.get?.("retry-after");
  const seconds = Number(failure.retryAfterSeconds ?? header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return { rateLimited: true, retryAt: now + Math.min(seconds * 1000, MAX_RESET_HORIZON_MS), source: "retry-after" };
  }

  const reset = parseResetPhrase(text, now);
  if (reset !== null) return { rateLimited: true, retryAt: reset, source: "reset-phrase" };

  const backoff = Math.min(DEFAULT_BACKOFF_MS * 2 ** Math.max(0, consecutive), MAX_BACKOFF_MS);
  return { rateLimited: true, retryAt: now + backoff, source: "backoff" };
}

/**
 * Parses "resets 6:10am (UTC)", "resets 6pm", or "resets Sep 25, 6pm (UTC)".
 * Times are read as UTC; a time already past today means tomorrow. Anything
 * unparseable, or more than a week out, returns null so the caller backs off
 * instead of sleeping on a misread date.
 */
export function parseResetPhrase(text, now = Date.now()) {
  const match = /resets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/iu.exec(text ?? "");
  if (!match) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem] = match;
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (hour > 23 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  const base = new Date(now);
  let candidate;
  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (month < 0) return null;
    candidate = Date.UTC(base.getUTCFullYear(), month, Number(dayText), hour, minute);
    if (candidate <= now - 24 * 60 * 60_000) candidate = Date.UTC(base.getUTCFullYear() + 1, month, Number(dayText), hour, minute);
  } else {
    candidate = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute);
    if (candidate <= now) candidate += 24 * 60 * 60_000;
  }
  if (candidate <= now || candidate - now > MAX_RESET_HORIZON_MS) return null;
  return candidate;
}

/**
 * Batch size that halves on a rate limit and grows by one after
 * `growAfter` consecutive clean completions, within [1, max].
 */
export class AdaptiveBatchSize {
  #max;
  #current;
  #growAfter;
  #streak = 0;

  constructor({ max = DEFAULT_BATCH_SIZE, initial = max, growAfter = 3 } = {}) {
    if (!Number.isInteger(max) || max < 1) throw new Error("max must be a positive integer.");
    if (!Number.isInteger(growAfter) || growAfter < 1) throw new Error("growAfter must be a positive integer.");
    this.#max = max;
    this.#current = Math.min(max, Math.max(1, Math.floor(initial)));
    this.#growAfter = growAfter;
  }

  get current() { return this.#current; }
  get max() { return this.#max; }

  rateLimited() {
    this.#streak = 0;
    this.#current = Math.max(1, Math.floor(this.#current / 2));
    return this.#current;
  }

  succeeded() {
    this.#streak += 1;
    if (this.#streak >= this.#growAfter && this.#current < this.#max) {
      this.#current += 1;
      this.#streak = 0;
    }
    return this.#current;
  }

  snapshot() { return { current: this.#current, max: this.#max }; }
}
