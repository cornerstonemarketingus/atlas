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
      // Swept opportunistically: an unbounded map is its own denial of service.
      if (buckets.size > 10_000) {
        for (const [existingKey, times] of buckets) {
          if (times.every((time) => at - time >= windowMs)) buckets.delete(existingKey);
        }
      }
      return { allowed: true, remaining: limit - recent.length, retryAfterSeconds: 0 };
    },

    /** Called on success, so a correct answer does not count against the limit. */
    clear({ bucket, client }) {
      buckets.delete(`${bucket}:${client}`);
    },

    size: () => buckets.size,
  };
}

export const LIMITS = {
  // A six-digit code is a million guesses; five a minute makes that useless.
  pairing: { limit: 5, windowMs: 60_000 },
  // Generous enough for a person answering prompts, far too slow to sweep.
  approval: { limit: 30, windowMs: 60_000 },
};
