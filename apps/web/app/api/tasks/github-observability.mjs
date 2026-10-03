// Only fixed categories and numeric quota metadata leave the request boundary.
// Never record request URLs, authorization, response bodies or provider messages.
const RESOURCES = new Set(["core", "search", "code_search", "graphql", "integration_manifest"]);

function integer(headers, name) {
  const raw = headers?.get(name);
  if (!raw || !/^\d{1,16}$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function category(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname !== "api.github.com") return "other";
    if (pathname.startsWith("/search/")) return "search";
    if (/^\/repos\/[^/]+\/[^/]+\/contents(?:\/|$)/u.test(pathname)) return "contents";
    if (/^\/repos\/[^/]+\/[^/]+\/commits(?:\/|$)/u.test(pathname)) return "commits";
    if (/^\/repos\/[^/]+\/[^/]+\/actions\//u.test(pathname)) return "actions";
    if (/^\/repos\/[^/]+\/[^/]+\/(?:pulls|issues)(?:\/|$)/u.test(pathname)) return "pulls_issues";
    return "other";
  } catch { return "other"; }
}

const SOURCES = new Set(["hosted_task_reads", "chat_repository_read", "chat_repository_search"]);

export function githubRequestObservation({ url, response, outcome, startedAt, endedAt, source = "hosted_task_reads", bytes = null }) {
  const headers = response?.headers;
  const remaining = integer(headers, "x-ratelimit-remaining");
  const retryRaw = headers?.get("retry-after");
  const retryDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(retryRaw ?? "") ? Date.parse(retryRaw) : NaN;
  const retrySeconds = integer(headers, "retry-after");
  const retryAfterMs = retrySeconds !== null && Number.isSafeInteger(retrySeconds * 1000)
    ? retrySeconds * 1000
    : Number.isFinite(retryDate) ? Math.max(0, retryDate - endedAt) : null;
  const status = response?.status ?? null;
  let failure = outcome;
  if (status === 403 || status === 429) {
    failure = remaining === 0 ? "primary_rate_limit"
      : retryAfterMs !== null ? "secondary_rate_limit"
      : status === 429 ? "rate_limit_unknown" : "permission_or_secondary_limit";
  } else if (status === 401) failure = "authentication";
  else if (status === 404) failure = "not_found";
  const resource = headers?.get("x-ratelimit-resource");
  return {
    atlas: "github", event: "github.request", source: SOURCES.has(source) ? source : "other",
    category: category(url), requests: 1, timestamp: new Date(endedAt).toISOString(),
    status, outcome: failure, latencyMs: Math.max(0, endedAt - startedAt),
    bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
    rateLimit: {
      resource: resource ? (RESOURCES.has(resource) ? resource : "other") : null,
      limit: integer(headers, "x-ratelimit-limit"), used: integer(headers, "x-ratelimit-used"),
      remaining, resetEpochSeconds: integer(headers, "x-ratelimit-reset"), retryAfterMs,
    },
  };
}

export function logGitHubObservation(observation) {
  console.info(JSON.stringify(observation));
}

/**
 * One GitHub request made outside fetchGitHubJson (the chat's repository
 * tools), observed the same way. Returns the untouched response plus its
 * observation so the caller can react to a rate limit without re-parsing
 * headers. Only the fixed fields above are logged.
 */
export async function observedGitHubFetch(fetcher, url, init, { source, observe = logGitHubObservation, clock = Date.now } = {}) {
  const startedAt = clock();
  let response;
  let outcome = "network_failure";
  const record = () => {
    const length = response?.headers?.get("content-length");
    const result = githubRequestObservation({ url, response, outcome, startedAt, endedAt: clock(), source, bytes: length && /^\d{1,12}$/u.test(length) ? Number(length) : null });
    // Observability must never change how the request itself behaves.
    try { observe(result); } catch { /* best effort */ }
    return result;
  };
  try {
    response = await fetcher(url, init);
    outcome = response.ok ? "success" : "http_failure";
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) outcome = "timeout";
    record();
    throw error;
  }
  return { response, observation: record() };
}

/** A repository-content cache decision. Counts and sizes only: never paths, repositories or content. */
export function githubCacheObservation({ outcome, category = "contents", source = "chat_repository_read", bytes = null, timestamp = Date.now() }) {
  return {
    atlas: "github", event: "github.cache", source: SOURCES.has(source) ? source : "other", category,
    outcome: ["hit", "miss", "coalesced", "blocked"].includes(outcome) ? outcome : "other",
    upstreamRequestsAvoided: outcome === "hit" || outcome === "coalesced" ? 1 : 0,
    bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null, timestamp: new Date(timestamp).toISOString(),
  };
}
