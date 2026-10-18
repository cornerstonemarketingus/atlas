import { estimateRequestTokens } from "./rate-limit-state.mjs";

/**
 * Prompt caching only pays when the start of a request is byte-identical to
 * an earlier one: providers (Groq on gpt-oss, OpenAI, vLLM's prefix cache)
 * reuse the longest matching prefix, and cached tokens do not count against
 * Groq's rate limits. So Atlas keeps policy, role, tool schemas and repository
 * instructions first and unchanged, and puts what changes (the request, the
 * latest tool result) after them (docs/PROGRAM.md Phase 1.4).
 *
 * A fingerprint makes that measurable: the hash and size of the stable
 * prefix, the size of the rest, and later the cached tokens the provider
 * reported. The same prefix hash across calls, and a rising cache-hit ratio,
 * show the architecture is working; a changed hash between two rounds of one
 * task shows something rewrote the prefix.
 */

/** JSON with object keys sorted, so the same tools always serialize to the same bytes. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The stable prefix is the tool schemas plus the leading system messages;
 * everything from the first non-system message on is dynamic.
 * @returns {Promise<{ model: string, prefixHash: string, prefixTokens: number, dynamicTokens: number, cachedTokens: number|null }>}
 */
export async function promptFingerprint({ model, messages = [], tools = null }) {
  const firstDynamic = messages.findIndex((message) => message?.role !== "system");
  const stable = firstDynamic === -1 ? messages : messages.slice(0, firstDynamic);
  const dynamic = firstDynamic === -1 ? [] : messages.slice(firstDynamic);
  const prefix = canonicalJson({ tools: tools ?? [], system: stable });
  return {
    model: String(model ?? ""),
    prefixHash: await sha256Hex(prefix),
    prefixTokens: estimateRequestTokens(prefix),
    dynamicTokens: estimateRequestTokens(canonicalJson(dynamic)),
    cachedTokens: null,
  };
}

/** Attaches what the provider reported as served from cache (usageFrom().cachedTokens). */
export function withCachedTokens(fingerprint, usage) {
  return { ...fingerprint, cachedTokens: Number.isFinite(usage?.cachedTokens) ? usage.cachedTokens : null, promptTokens: Number.isFinite(usage?.promptTokens) ? usage.promptTokens : null };
}

/**
 * Cache effectiveness over a set of calls: the share of prompt tokens the
 * provider served from cache, and how many distinct prefixes there were.
 * Calls whose provider did not report cached tokens are counted separately,
 * never as misses.
 */
export function cacheReport(fingerprints) {
  let prompt = 0;
  let cached = 0;
  let unreported = 0;
  for (const fingerprint of fingerprints) {
    if (!Number.isFinite(fingerprint.cachedTokens) || !Number.isFinite(fingerprint.promptTokens)) { unreported += 1; continue; }
    prompt += fingerprint.promptTokens;
    cached += fingerprint.cachedTokens;
  }
  return {
    calls: fingerprints.length,
    reportedCalls: fingerprints.length - unreported,
    distinctPrefixes: new Set(fingerprints.map((fingerprint) => `${fingerprint.model}:${fingerprint.prefixHash}`)).size,
    cacheHitRatio: prompt > 0 ? cached / prompt : null,
  };
}

/**
 * Within one task, the stable prefix must not change between rounds for the
 * same model. Returns the rounds where it did (empty when stable).
 */
export function prefixChanges(fingerprintsInOrder) {
  const changes = [];
  const last = new Map();
  fingerprintsInOrder.forEach((fingerprint, index) => {
    const previous = last.get(fingerprint.model);
    if (previous !== undefined && previous !== fingerprint.prefixHash) changes.push({ round: index, model: fingerprint.model });
    last.set(fingerprint.model, fingerprint.prefixHash);
  });
  return changes;
}
