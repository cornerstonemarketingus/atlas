/**
 * Rate limiting for the two endpoints an attacker actually reaches.
 *
 * Pairing takes a six-digit code, which is a million guesses; an unlimited
 * endpoint turns that into a few minutes of work. Approval decisions take an
 * identifier, and a paired device that has been stolen or a token that has
 * leaked should not be able to sweep for pending approvals.
 *
 * The counter is per client and per bucket, so hammering approvals does not
 * lock out pairing and a noisy device does not lock out a quiet one.
 */
export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();
  let sweepCursor = 0;

  return {
    /**
     * @returns {{ allowed: boolean, retryAfterSeconds: number, remaining: number }}
     */
    check({ bucket, client, limit, windowMs }) {
      const key = `${bucket}:${client}`;
      const at = now();
      const recent = (buckets.get(key) ?? []).filter((time) => at - time < windowMs);

      if (recent.length >= limit) {
        buckets.set(key, recent);
        const oldest = recent[0];
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (at - oldest)) / 1000)),
        };
      }

      recent.push(at);
      buckets.set(key, recent);
      // Amortized, not a full scan. Sweeping the whole map on every call past
      // a size threshold made the limiter quadratic: 200k distinct clients
      // cost minutes of blocking CPU on the same event loop that serves the
      // approval endpoint, so the limiter became the way to stall what it
      // exists to protect. A bounded number of the oldest keys is checked per
      // call instead, which keeps the map trimmed without ever scanning it.
      sweepCursor = sweepSome(buckets, sweepCursor, at, windowMs);
      return { allowed: true, remaining: limit - recent.length, retryAfterSeconds: 0 };
    },

    /** Called on success, so a correct answer does not count against the limit. */
    clear({ bucket, client }) {
      buckets.delete(`${bucket}:${client}`);
    },

    size: () => buckets.size,
  };
}

/** Checks a bounded slice of the map per call, resuming where it left off. */
function sweepSome(buckets, cursor, at, windowMs, budget = 16) {
  if (buckets.size === 0) return 0;
  const keys = buckets.keys();
  let index = 0;
  let checked = 0;
  let position = cursor;
  for (const key of keys) {
    if (index++ < position) continue;
    const times = buckets.get(key);
    if (times && times.every((time) => at - time >= windowMs)) buckets.delete(key);
    if (++checked >= budget) break;
  }
  position += checked;
  return position >= buckets.size ? 0 : position;
}

/**
 * A per-secret attempt counter, independent of who is asking.
 *
 * The pairing limit was keyed on the client's remote address, and a six-digit
 * code with a five-minute life has only 900k possibilities. On a LAN — an
 * IPv6 /64 especially — an attacker binds thousands of source addresses and
 * gets five guesses each. Counting against the CODE rather than the caller is
 * the limit that actually holds.
 */
export function createAttemptCounter({ maximum = 5 } = {}) {
  const attempts = new Map();
  return {
    /** @returns false once this secret has been guessed at too many times. */
    record(key) {
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      return count <= maximum;
    },
    burn(key) { attempts.set(key, maximum + 1); },
    clear(key) { attempts.delete(key); },
    exhausted(key) { return (attempts.get(key) ?? 0) > maximum; },
  };
}

export const LIMITS = {
  // A six-digit code is a million guesses; five a minute makes that useless.
  pairing: { limit: 5, windowMs: 60_000 },
  // Generous enough for a person answering prompts, far too slow to sweep.
  approval: { limit: 30, windowMs: 60_000 },
};
