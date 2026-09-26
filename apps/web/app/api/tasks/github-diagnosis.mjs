/**
 * Turns a GitHub refusal into something a person can act on.
 *
 * Task creation returned a bare "GitHub Actions rejected the task dispatch"
 * (HTTP 502) whether the token had expired, lacked a permission, could not
 * see the repository or sent an input the workflow does not declare — four
 * different fixes behind one sentence. The status code is what tells them
 * apart; no response body is echoed, because it can contain request data.
 */
export function explainGitHubFailure(status, { workflow = "the Atlas workflow", repository = "the repository" } = {}) {
  switch (status) {
    case 401:
      return { code: "GITHUB_TOKEN_INVALID", blocked: "BLOCKED_BY_MISSING_CREDENTIAL", message: "GitHub rejected Atlas's credential: it has expired or been revoked.", unblock: "Create a new token (or reinstall the GitHub App), save it as the ATLAS_GITHUB_TOKEN repository secret, and redeploy." };
    case 403:
      return { code: "GITHUB_PERMISSION_MISSING", blocked: "BLOCKED_BY_PERMISSION", message: `Atlas's GitHub credential cannot run workflows on ${repository}.`, unblock: "Give the token or GitHub App Actions: read and write permission on this repository (a rate limit also answers 403 — if so, wait and retry)." };
    case 404:
      return { code: "GITHUB_NOT_FOUND", blocked: "BLOCKED_BY_PERMISSION", message: `GitHub could not find ${workflow} on ${repository} with Atlas's credential.`, unblock: "Check that the repository is shared with the token or GitHub App and that the workflow file exists on main." };
    case 422:
      return { code: "GITHUB_DISPATCH_INVALID", blocked: "BLOCKED_BY_DEPENDENCY", message: `GitHub refused the inputs sent to ${workflow}.`, unblock: "The workflow on main does not match this Atlas version; merge or redeploy so both come from the same commit." };
    default:
      return status >= 500
        ? { code: "GITHUB_UNAVAILABLE", blocked: "BLOCKED_BY_PROVIDER", message: "GitHub is having trouble right now.", unblock: "Nothing was started. Try again in a few minutes." }
        : { code: "GITHUB_DISPATCH_FAILED", blocked: "BLOCKED_BY_PROVIDER", message: `GitHub refused the task dispatch (HTTP ${status}).`, unblock: "Check the GitHub credential and workflow configuration." };
  }
}

/**
 * A read-only probe of the dispatch path: can this credential see the
 * workflow it would dispatch? Used by setup status, so "ready" means the
 * credential works, not merely that one is set.
 */
export async function probeGitHubDispatch({ token, repository, workflow = "atlas-runner.yml", fetcher = fetch }) {
  if (!token) return { ok: false, ...explainGitHubFailure(401, { workflow, repository }), message: "No GitHub credential is configured for task dispatch." };
  const [owner, repo] = String(repository).split("/");
  try {
    const response = await fetcher(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "atlas-control-plane", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) return { ok: true };
    return { ok: false, status: response.status, ...explainGitHubFailure(response.status, { workflow, repository }) };
  } catch {
    return { ok: false, ...explainGitHubFailure(503, { workflow, repository }) };
  }
}
