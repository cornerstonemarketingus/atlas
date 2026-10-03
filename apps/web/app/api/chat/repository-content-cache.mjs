import { githubCacheObservation, logGitHubObservation } from "../tasks/github-observability.mjs";

/**
 * Reuse of repository content the hosted chat has already retrieved.
 *
 * Two different limits were being conflated: how much of a file the MODEL may
 * see in one tool result (bounded pages, unchanged) and how much GitHub is
 * asked for. Every page, reread and second agent used to cost a full Contents
 * request for the same bytes. Here the file is retrieved once per immutable
 * identity (repository + commit + path) and every page is sliced from it.
 *
 * Rules this module does NOT enforce, because the caller must:
 *  - Authorization comes first. A cache hit is never authorization; callers
 *    run the workspace allowlist check before any lookup here.
 *  - Cached repository text stays untrusted data. It is returned to the same
 *    code path that wraps it with `asData`, not interpreted here.
 *
 * Branch names move, so they are never a content key. A ref is resolved to a
 * commit (remembered only briefly) and content is keyed by that commit.
 */

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONTENT_TTL_MS = 10 * 60_000;
const DEFAULT_REF_TTL_MS = 60_000;
/** After a rate limit, uncached reads fail fast for at most this long, then one probe is allowed. */
const MAX_BLOCK_MS = 60_000;

export function createRepositoryContentCache({
  maxBytes = DEFAULT_MAX_BYTES, contentTtlMs = DEFAULT_CONTENT_TTL_MS, refTtlMs = DEFAULT_REF_TTL_MS,
  now = Date.now, observe = logGitHubObservation,
} = {}) {
  const entries = new Map(); // insertion order doubles as LRU order
  const inflight = new Map();
  const refs = new Map();
  let usedBytes = 0;
  let blockedUntil = 0;

  const emit = (event) => { try { observe(event); } catch { /* best effort */ } };
  const note = (outcome, category, bytes) => emit(githubCacheObservation({ outcome, category, bytes, timestamp: now() }));

  function evict() {
    for (const [key, entry] of entries) {
      if (usedBytes <= maxBytes) break;
      entries.delete(key);
      usedBytes -= entry.bytes;
    }
  }

  function store(key, value, bytes) {
    if (bytes > maxBytes) return;
    const previous = entries.get(key);
    if (previous) { usedBytes -= previous.bytes; entries.delete(key); }
    entries.set(key, { value, bytes, expiresAt: now() + contentTtlMs });
    usedBytes += bytes;
    evict();
  }

  /**
   * Returns the cached value for `key`, joins an identical retrieval already in
   * flight, or runs `load` once. `load` resolves to `{ value, bytes, cache }`;
   * only `cache: true` results (successful immutable reads) are kept, so a
   * failure is never replayed to the next caller.
   */
  async function getOrLoad(key, load, { category = "contents" } = {}) {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) {
      entries.delete(key); entries.set(key, hit); // most recently used
      note("hit", category, hit.bytes);
      return hit.value;
    }
    if (hit) { entries.delete(key); usedBytes -= hit.bytes; }
    const pending = inflight.get(key);
    if (pending) { note("coalesced", category, null); return pending; }
    note("miss", category, null);
    const promise = (async () => {
      try {
        const loaded = await load();
        if (loaded.cache) store(key, loaded.value, loaded.bytes ?? 0);
        return loaded.value;
      } finally { inflight.delete(key); }
    })();
    inflight.set(key, promise);
    return promise;
  }

  /**
   * Branch/tag/HEAD -> commit, remembered only briefly so a moving branch is
   * noticed. `load` resolves to `{ value, cache }` like getOrLoad's loader.
   */
  async function resolveRef(key, load) {
    const known = refs.get(key);
    if (known && known.expiresAt > now()) return known.value;
    const refKey = `ref:${key}`;
    const pending = inflight.get(refKey);
    if (pending) { note("coalesced", "commits", null); return pending; }
    const promise = (async () => {
      try {
        const loaded = await load();
        if (loaded.cache) refs.set(key, { value: loaded.value, expiresAt: now() + refTtlMs });
        return loaded.value;
      } finally { inflight.delete(refKey); }
    })();
    inflight.set(refKey, promise);
    return promise;
  }

  return {
    getOrLoad,
    resolveRef,
    /** Milliseconds uncached reads must wait after a rate limit; 0 when clear. */
    blockedForMs: () => Math.max(0, blockedUntil - now()),
    block(milliseconds) {
      if (Number.isFinite(milliseconds) && milliseconds > 0) blockedUntil = Math.max(blockedUntil, now() + Math.min(milliseconds, MAX_BLOCK_MS));
    },
    noteBlocked: (category = "contents") => note("blocked", category, null),
    stats: () => ({ entries: entries.size, bytes: usedBytes, resolvedRefs: refs.size, inflight: inflight.size }),
    clear() { entries.clear(); refs.clear(); usedBytes = 0; blockedUntil = 0; },
  };
}

/** Shared by every chat request served by this Worker isolate. */
export const repositoryContentCache = createRepositoryContentCache();
