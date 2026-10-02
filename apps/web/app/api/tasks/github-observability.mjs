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
    if (/^\/repos\/[^/]+\/[^/]+\/actions\//u.test(pathname)) return "actions";
    if (/^\/repos\/[^/]+\/[^/]+\/(?:pulls|issues)(?:\/|$)/u.test(pathname)) return "pulls_issues";
    return "other";
  } catch { return "other"; }
}

export function githubRequestObservation({ url, response, outcome, startedAt, endedAt }) {
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
    atlas: "github", event: "github.request", source: "hosted_task_reads",
    category: category(url), requests: 1, timestamp: new Date(endedAt).toISOString(),
    status, outcome: failure, latencyMs: Math.max(0, endedAt - startedAt),
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
