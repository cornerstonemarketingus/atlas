/**
 * Read side of the GitHub Actions API: the requests used to turn a stored task
 * row into live status.
 *
 * WHY POLLING AND NOT A CALLBACK
 * ------------------------------
 * The obvious alternative is an inbound `POST /api/tasks/:id/status` that the
 * runner calls as it progresses. We deliberately did not build that:
 *   - it needs a new shared secret distributed to every runner, plus replay and
 *     spoofing defences, to protect a row that GitHub already owns the truth of;
 *   - it is a new unauthenticated-by-default public write surface on the
 *     control plane, whose whole job is dispatching code-modifying jobs;
 *   - it goes stale the moment a runner is killed mid-job, whereas GitHub still
 *     reports that run as `cancelled`/`timed_out` correctly.
 * GitHub is already the source of truth for run state, and we already hold a
 * token that can read it. The cost is that status is pull-based: it is as fresh
 * as the last dashboard poll, not push-fresh.
 *
 * Request builders are kept pure (no fetch, no schema import) so they can be
 * unit-tested under plain `node --test`; the same header/bounding style as
 * dispatch.mjs.
 */

const GITHUB_API = "https://api.github.com";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW_PATTERN = /^(?:[A-Za-z0-9_.-]{1,128}|[1-9][0-9]{0,18})$/u;

export function githubReadHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "atlas-control-plane",
    "x-github-api-version": "2022-11-28",
  };
}

function repositoryParts(repository) {
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) throw new Error("Repository is invalid.");
  const [owner, name] = repository.split("/");
  return [encodeURIComponent(owner), encodeURIComponent(name)];
}

/** Recent runs of one workflow, newest first — the pool the run-id heuristic matches against. */
export function workflowRunsRequest({ token, repository, workflow, perPage = 30 }) {
  if (!WORKFLOW_PATTERN.test(String(workflow))) throw new Error("Workflow is invalid.");
  const [owner, name] = repositoryParts(repository);
  const bounded = Math.min(Math.max(Number(perPage) || 1, 1), 100);
  return {
    url: `${GITHUB_API}/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=${bounded}`,
    init: { method: "GET", headers: githubReadHeaders(token) },
  };
}

/** One already-resolved run, so an older task still reports its final status. */
export function workflowRunRequest({ token, repository, runId }) {
  if (typeof runId !== "number" || !Number.isInteger(runId) || runId <= 0) throw new Error("Run id is invalid.");
  const [owner, name] = repositoryParts(repository);
  return {
    url: `${GITHUB_API}/repos/${owner}/${name}/actions/runs/${runId}`,
    init: { method: "GET", headers: githubReadHeaders(token) },
  };
}

/**
 * The pull request opened from a coder task's deterministic head branch.
 *
 * This needs `pull_requests: read`, which the GitHub App installation token
 * minted in github-app.mjs deliberately does NOT request (it asks only for the
 * `actions` permission it needs to dispatch). So on the App path this call is
 * expected to 403 and the caller degrades to "no PR link"; it resolves only
 * when Atlas is running on an `ATLAS_GITHUB_TOKEN` that can read pull requests.
 * Widening the installation token is not free — requesting a permission the
 * installation was not granted makes token creation fail outright, which would
 * break dispatch itself.
 */
export function pullRequestForBranchRequest({ token, repository, branch }) {
  const [owner, name] = repositoryParts(repository);
  if (typeof branch !== "string" || !branch || branch.length > 255) throw new Error("Branch is invalid.");
  return {
    url: `${GITHUB_API}/repos/${owner}/${name}/pulls?head=${owner}%3A${encodeURIComponent(branch)}&state=all&per_page=1`,
    init: { method: "GET", headers: githubReadHeaders(token) },
  };
}

/** Only the fields the dashboard needs, so an unexpected payload can't leak through. */
export function normalizeRun(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "number") return null;
  return {
    id: value.id,
    // The workflow sets `run-name` to carry the dispatched task id; this is
    // what makes run matching exact rather than time-based. Older runs, and
    // runs triggered from the GitHub UI, carry the plain workflow name.
    name: typeof value.name === "string" ? value.name : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    event: typeof value.event === "string" ? value.event : null,
    status: typeof value.status === "string" ? value.status : null,
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
    htmlUrl: typeof value.html_url === "string" ? value.html_url : null,
  };
}

export function normalizePullRequest(value) {
  if (!value || typeof value !== "object" || typeof value.number !== "number") return null;
  return {
    number: value.number,
    url: typeof value.html_url === "string" ? value.html_url : null,
    state: typeof value.state === "string" ? value.state : null,
    merged: value.merged_at !== null && value.merged_at !== undefined,
  };
}

/**
 * Bounded GET returning parsed JSON, or null for any failure at all — a
 * transient GitHub error must degrade the task list to "status unknown", never
 * fail it.
 */
export async function fetchGitHubJson(request, fetcher = fetch, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(request.url, { ...request.init, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
