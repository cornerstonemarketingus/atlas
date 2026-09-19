/**
 * A narrowly scoped GitHub Actions client for the optional remote executor.
 *
 * It can dispatch one workflow and read that workflow's runs. It cannot mint
 * tokens, change secrets, or touch repository settings — the coding agent
 * must never hold a credential that can widen its own access, and this is
 * the adapter the coding agent's work flows through.
 */
const API_ROOT = "https://api.github.com";

export function createGitHubActionsClient({ token, repository, workflow, ref = "main", fetchImpl = fetch }) {
  if (!token) throw new Error("A GitHub token is required for the GitHub Actions executor.");
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "")) throw new Error("repository must be in owner/name form.");
  if (!workflow) throw new Error("A workflow file name is required.");

  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "atlas-local-control",
  };

  async function call(path, init = {}) {
    const response = await fetchImpl(`${API_ROOT}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The message is surfaced to the operator, so it must never echo the
      // request headers back: `body.message` is GitHub's own prose.
      const error = new Error(`GitHub returned HTTP ${response.status}: ${body.message ?? "no detail"}.`);
      error.code = response.status === 401 || response.status === 403 ? "GITHUB_NOT_AUTHORIZED" : "GITHUB_REQUEST_FAILED";
      throw error;
    }
    return body;
  }

  return {
    async dispatch({ objective, model, signal }) {
      const dispatchedAt = new Date().toISOString();
      await call(`/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref, inputs: { objective, model } }),
      });
      // Dispatch returns 204 with no run ID, so the run has to be found by
      // its creation time. Anything older than this dispatch is somebody
      // else's run and must not be reported as ours.
      const runs = await call(`/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=10`, { signal });
      const mine = (runs?.workflow_runs ?? []).filter((run) => run.created_at >= dispatchedAt);
      const run = mine[0];
      return run
        ? { id: run.id, status: normalizeStatus(run), url: run.html_url }
        : { id: `pending:${dispatchedAt}`, status: "queued", url: null };
    },

    async poll({ id, signal }) {
      if (String(id).startsWith("pending:")) {
        const createdAfter = String(id).slice("pending:".length);
        const runs = await call(`/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=10`, { signal });
        const run = (runs?.workflow_runs ?? []).find((candidate) => candidate.created_at >= createdAfter);
        return run ? { id: run.id, status: normalizeStatus(run), url: run.html_url } : { id, status: "queued", url: null };
      }
      const run = await call(`/repos/${repository}/actions/runs/${id}`, { signal });
      return { id: run.id, status: normalizeStatus(run), url: run.html_url };
    },
  };
}

function normalizeStatus(run) {
  if (run.status !== "completed") return run.status === "in_progress" ? "running" : "queued";
  if (run.conclusion === "success") return "completed";
  if (run.conclusion === "cancelled") return "cancelled";
  return "failed";
}
