import { githubRequestObservation } from "../tasks/github-observability.mjs";

// Keep response details at the authenticated tool boundary, never in telemetry.
// Only fixed diagnostic categories cross into model/user output: GitHub can
// echo submitted queries (which can contain credentials) in its message/errors.
export async function githubToolError(response, operation) {
  let raw = "";
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (bytes < 8192) {
        const { value, done } = await reader.read();
        if (done) break;
        const part = value.subarray(0, 8192 - bytes);
        bytes += part.length; raw += decoder.decode(part, { stream: true });
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  let body;
  try { body = JSON.parse(raw); } catch { body = {}; }
  const message = String(body?.message ?? "");
  const { rateLimit } = githubRequestObservation({ response, startedAt: Date.now(), endedAt: Date.now() });
  const limited = response.status === 429 || (response.status === 403 && (rateLimit.remaining === 0 || rateLimit.retryAfterMs !== null || /rate limit|secondary limit|abuse/iu.test(message)));
  const reset = rateLimit.remaining === 0 && rateLimit.resetEpochSeconds !== null ? Math.max(0, rateLimit.resetEpochSeconds * 1000 - Date.now()) : 0;
  const retryAfterMs = limited ? Math.max(rateLimit.retryAfterMs ?? 60_000, reset) : null;
  const category = limited ? "quota" : response.status === 401 ? "authentication" : response.status === 403 ? "permission" : [400, 422].includes(response.status) ? "invalid_request" : response.status === 404 ? "not_found" : "unavailable";
  const invalidCause = /parse|syntax/iu.test(message) ? "GitHub could not parse the search query"
    : /must include|missing.*(?:query|q\b)|(?:query|q\b).*required/iu.test(message) ? "GitHub requires a search term or query parameter"
      : /(?:query|search).*(?:long|length)|256/iu.test(message) ? "the search query exceeds GitHub's length limit"
        : /api.version|unsupported.*version/iu.test(message) ? "GitHub rejected the API version"
          : /query|validation/iu.test(message) ? "GitHub rejected the query or parameters as invalid" : "GitHub rejected the request";
  const cause = category === "quota" ? "GitHub API quota is exhausted or temporarily rate-limited"
    : category === "authentication" ? "GitHub rejected the credential"
      : category === "permission" ? "GitHub denied access to this operation"
        : category === "not_found" ? "the repository, path or ref was not found or is inaccessible"
          : category === "invalid_request" ? invalidCause
            : "GitHub is unavailable or returned an unexpected response";
  const action = category === "quota" ? `Wait at least ${Math.ceil(retryAfterMs / 1000)} seconds before another GitHub request; use already retrieved evidence meanwhile.`
    : category === "authentication" ? "Reconnect GitHub or replace its credential."
      : category === "permission" ? "Check the GitHub credential's repository access and required permissions."
        : category === "not_found" ? "Check the repository, path, ref and access permissions."
          : category === "invalid_request" ? "Correct the query or parameters, or read a known file with read_repository_file; do not repeat the identical request."
            : "Try again later or use another available source.";
  // Structured field/code details are selected from a closed vocabulary.
  const details = (Array.isArray(body?.errors) ? body.errors : []).slice(0, 8).map(error => ({
    resource: ["Search", "Code", "Repository"].includes(error?.resource) ? error.resource : "unknown",
    field: ["q", "query", "page", "per_page", "path", "ref"].includes(error?.field) ? error.field : "unknown",
    code: ["invalid", "missing", "missing_field", "unprocessable", "custom"].includes(error?.code) ? error.code : "unknown",
  }));
  const rawId = response.headers.get("x-github-request-id") ?? "";
  const requestId = /^[A-F0-9:]{1,100}$/iu.test(rawId) ? rawId : null;
  const error = { operation, status: response.status, category, cause, action, retryAfterMs, details, requestId, rateLimit };
  return { ok: false, label: `${operation} failed (GitHub ${response.status}: ${category})`, error, content: `${operation}: ${cause} (HTTP ${response.status}). ${action}\n${JSON.stringify({ details })}` };
}
