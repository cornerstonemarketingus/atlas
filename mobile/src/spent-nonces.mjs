/**
 * A record of approval links that have already been opened, kept across
 * restarts.
 *
 * A single-use link is only single-use if the record of its use outlives the
 * process. Holding spent nonces in a `Set` on the handler meant the record
 * was created empty every time the app launched: a notification forwarded to
 * someone else, or one still sitting in a shared notification history, opened
 * again cleanly after a restart, for as long as the link had left to run. The
 * signature was valid and the expiry had not passed, so nothing else in the
 * chain objected.
 *
 * Nonces are not secrets. They are single-use identifiers inside a link whose
 * authority comes from its signature, so ordinary preference storage is the
 * right place for them and the platform vault is not needed.
 *
 * The state is loaded once and kept in memory so that `has` can stay
 * synchronous -- link verification is on the path between a tap and a screen,
 * and it cannot wait on a disk read. Writes are persisted as they happen.
 */
const DEFAULT_KEY = "atlas.deeplink.spent";

/** Bounded so a device that receives many links does not grow this forever. */
const MAX_ENTRIES = 512;

export function createSpentNonceLedger({ storage, key = DEFAULT_KEY, now = Date.now, onError = () => {} } = {}) {
  if (!storage) throw new Error("A spent-nonce ledger needs somewhere to persist to.");
  /** nonce -> the millisecond after which the link is expired anyway. */
  let entries = new Map();
  let loaded = false;

  function prune(at) {
    for (const [nonce, expiresAtMs] of entries) {
      // Past its expiry the link is refused on those grounds alone, so
      // remembering it any longer buys nothing.
      if (!(expiresAtMs > at)) entries.delete(nonce);
    }
    while (entries.size > MAX_ENTRIES) {
      // Oldest expiry first: those are closest to being refused on expiry.
      const oldest = [...entries.entries()].sort((a, b) => a[1] - b[1])[0];
      entries.delete(oldest[0]);
    }
  }

  async function persist() {
    try {
      await storage.set(key, JSON.stringify([...entries]));
    } catch (error) {
      // A ledger that cannot be written is reported rather than silently
      // downgrading to in-memory: it means restarts stop being covered.
      onError({ stage: "persist", error });
    }
  }

  return {
    /**
     * Reads the ledger back. Must be awaited before the first link is
     * handled; until then the ledger is empty and would accept a replay.
     */
    async load() {
      try {
        const raw = await storage.get(key);
        const parsed = raw ? JSON.parse(raw) : [];
        entries = new Map(
          (Array.isArray(parsed) ? parsed : [])
            .filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" && Number.isFinite(Number(entry[1])))
            .map((entry) => [entry[0], Number(entry[1])]),
        );
      } catch (error) {
        // Unreadable is treated as empty rather than as fatal, but it is
        // said out loud, because an empty ledger accepts replays.
        entries = new Map();
        onError({ stage: "load", error });
      }
      prune(now());
      loaded = true;
      return { loaded: true, size: entries.size };
    },

    get loaded() {
      return loaded;
    },

    has(nonce) {
      return entries.has(nonce);
    },

    /** Recorded in memory immediately; the write is awaited by the caller. */
    add(nonce, expiresAtMs) {
      entries.set(nonce, Number(expiresAtMs) || 0);
      prune(now());
      return persist();
    },

    get size() {
      return entries.size;
    },
  };
}
