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
      return { code: "GITHUB_TOKEN_INVALID", blocked: "BLOCKED_BY_MISSING_CREDENTIAL", message: "GitHub rejected Atlas's credential: it has expired or been revoked.", unblock: "Save a valid token (Actions: read and write, Contents: read on the repository) as the ATLAS_GITHUB_TOKEN repository secret, then run the \"Deploy Atlas web to Cloudflare Workers\" workflow: the website only picks up the new token when that workflow runs." };
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
 * What kind of GitHub credential is active, from its prefix alone. Only the
 * kind is ever reported, never any part of the value. The fix for a missing
 * permission is different for each kind, so a diagnosis that does not know
 * which one it is has to guess.
 */
export function credentialKind(token, { githubApp = false } = {}) {
  if (githubApp) return "github-app";
  if (!token) return "none";
  if (token.startsWith("github_pat_")) return "fine-grained-pat";
  if (token.startsWith("ghp_")) return "classic-pat";
  if (token.startsWith("ghs_")) return "installation-token";
  if (token.startsWith("gho_")) return "oauth-token";
  return "unknown";
}

/** Where to grant a missing permission, per credential kind. */
function grantInstructions(kind, permission, repository) {
  switch (kind) {
    case "fine-grained-pat":
      return `Edit the fine-grained token (github.com/settings/tokens?type=beta) → Repository access must include ${repository} → Repository permissions → ${permission}: Read and write. Save it as the ATLAS_GITHUB_TOKEN secret, then run "Deploy Atlas web to Cloudflare Workers".`;
    case "classic-pat":
      return `A classic token needs the "repo" scope to run workflows. Add it (github.com/settings/tokens), save the token as ATLAS_GITHUB_TOKEN, then run "Deploy Atlas web to Cloudflare Workers". A fine-grained token or the GitHub App is safer.`;
    case "github-app":
      return `In the GitHub App's settings → Permissions → Repository permissions → ${permission}: Read and write, then accept the new permission on the installation for ${repository}.`;
    default:
      return `Give Atlas's GitHub credential ${permission}: Read and write on ${repository}, then run "Deploy Atlas web to Cloudflare Workers".`;
  }
}

/**
 * Why the GitHub App could not get an installation token, and the fix. The
 * token request asks for Actions: write; an App without that permission is
 * refused here, before any dispatch, so this is where it has to be named.
 */
export function explainGitHubAppFailure(error, { repository = "the repository" } = {}) {
  const base = { credential: "github-app", blocked: "BLOCKED_BY_MISSING_CREDENTIAL" };
  switch (error?.code) {
    case "GITHUB_APP_PERMISSION_MISSING":
      return { ...base, code: "GITHUB_PERMISSION_MISSING", blocked: "BLOCKED_BY_PERMISSION", missingPermission: "Actions", message: `The GitHub App does not have Actions: write on ${repository}, so it cannot start runs.`, unblock: grantInstructions("github-app", "Actions", repository) };
    case "GITHUB_APP_INSTALLATION_NOT_FOUND":
      return { ...base, code: "GITHUB_APP_INSTALLATION_NOT_FOUND", message: "GitHub has no installation of the App with the configured installation id.", unblock: `Install the GitHub App on ${repository} and save its installation id as ATLAS_GITHUB_INSTALLATION_ID, then run "Deploy Atlas web to Cloudflare Workers".` };
    case "GITHUB_APP_KEY_REJECTED":
      return { ...base, code: "GITHUB_APP_KEY_REJECTED", message: "GitHub rejected the App's signed request: the App id and private key do not match.", unblock: "Generate a new private key in the App's settings, save it as ATLAS_GITHUB_APP_PRIVATE_KEY with the matching ATLAS_GITHUB_APP_ID, then redeploy." };
    default:
      return { ...base, code: "GITHUB_APP_AUTH_FAILED", message: "GitHub App authentication failed.", unblock: "Check the ATLAS_GITHUB_APP_* secrets (app id, installation id, private key) and redeploy." };
  }
}

/** A 403 with no requests left is GitHub's rate limit, not a missing permission. */
export function isRateLimited(headers) {
  return headers?.get?.("x-ratelimit-remaining") === "0";
}

/**
 * A refused dispatch, explained for the credential that was used: a 403 is
 * told apart from a rate limit, and a missing permission comes with the fix
 * for that kind of credential. Never the response body.
 */
export function explainDispatchFailure(response, { workflow, repository, credential = "unknown" }) {
  if (response.status === 403 && isRateLimited(response.headers)) {
    return { code: "GITHUB_RATE_LIMITED", blocked: "BLOCKED_BY_PROVIDER", credential, message: "GitHub's API rate limit for Atlas's credential is used up.", unblock: "Wait for the limit to reset (usually within an hour) and ask again; nothing needs changing." };
  }
  if (response.status === 403) {
    return {
      code: "GITHUB_PERMISSION_MISSING", blocked: "BLOCKED_BY_PERMISSION", credential, missingPermission: "Actions",
      message: `Atlas's GitHub credential (${credential}) cannot run workflows on ${repository}.`,
      unblock: grantInstructions(credential, "Actions", repository),
    };
  }
  return { credential, ...explainGitHubFailure(response.status, { workflow, repository }) };
}

const githubHeaders = (token) => ({ accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "atlas-control-plane", "x-github-api-version": "2022-11-28" });

/**
 * Probes the dispatch path with the permission dispatch actually needs.
 *
 * Reading the workflow proves only Actions: read; a credential with that
 * alone passes a read-only check and then fails every real dispatch with 403
 * (production ran for weeks in exactly that state while setup said "ready").
 * So after the read, the probe dispatches the workflow to a branch that
 * cannot exist. GitHub authorizes before it validates: without Actions: write
 * it answers 403; with it, 422 "No ref found", and nothing runs. A classic
 * token reports its scopes on every response, so it needs no write probe.
 *
 * Returns the credential kind and, when something is missing, exactly which
 * permission and how to grant it for that kind. Never the token.
 */
export async function probeGitHubDispatch({ token, repository, workflow = "atlas-runner.yml", fetcher = fetch, githubApp = false }) {
  const kind = credentialKind(token, { githubApp });
  if (!token) return { ok: false, credential: kind, ...explainGitHubFailure(401, { workflow, repository }), message: "No GitHub credential is configured for task dispatch." };
  const [owner, repo] = String(repository).split("/");
  const workflowUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}`;
  const missing = (permission) => ({
    ok: false, credential: kind, code: "GITHUB_PERMISSION_MISSING", blocked: "BLOCKED_BY_PERMISSION", missingPermission: permission,
    message: `Atlas's GitHub credential (${kind}) can read ${repository} but lacks ${permission}: write, so it cannot start runs.`,
    unblock: grantInstructions(kind, permission, repository),
  });
  const rateLimited = () => ({ ok: false, credential: kind, code: "GITHUB_RATE_LIMITED", blocked: "BLOCKED_BY_PROVIDER", message: "GitHub's API rate limit for Atlas's credential is used up.", unblock: "Wait for the limit to reset (usually within an hour); nothing needs changing." });
  try {
    const read = await fetcher(workflowUrl, { headers: githubHeaders(token), signal: AbortSignal.timeout(8_000) });
    if (read.status === 403 && isRateLimited(read.headers)) return rateLimited();
    if (!read.ok) return { ok: false, status: read.status, credential: kind, ...explainGitHubFailure(read.status, { workflow, repository }) };
    if (kind === "classic-pat") {
      const scopes = (read.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim());
      return scopes.includes("repo") ? { ok: true, credential: kind } : missing("repo scope");
    }
    const probeRef = `atlas-permission-probe-${crypto.randomUUID()}`;
    const write = await fetcher(`${workflowUrl}/dispatches`, {
      method: "POST",
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ ref: probeRef }),
      signal: AbortSignal.timeout(8_000),
    });
    if (write.status === 403) return isRateLimited(write.headers) ? rateLimited() : missing("Actions");
    if (write.status === 422) {
      const detail = await write.text().catch(() => "");
      // Only "no such ref" proves the request was authorized and reached validation.
      return /no ref found|ref.*not.*found/iu.test(detail)
        ? { ok: true, credential: kind }
        : { ok: false, credential: kind, code: "GITHUB_PERMISSION_UNVERIFIED", blocked: "BLOCKED_BY_PROVIDER", message: "GitHub answered the permission check in an unexpected way.", unblock: "Start a task to confirm; if it is refused, the message will name the cause." };
    }
    if (write.status === 204) return { ok: true, credential: kind };
    return { ok: false, status: write.status, credential: kind, ...explainGitHubFailure(write.status, { workflow, repository }) };
  } catch {
    return { ok: false, credential: kind, ...explainGitHubFailure(503, { workflow, repository }) };
  }
}
