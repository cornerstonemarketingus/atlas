import { explainGitHubFailure } from "./github-diagnosis.mjs";
import { isDeploymentOwner } from "./self-protection.mjs";

/**
 * Per-user repository authorization (SECURITY-REVIEW SEC-1).
 *
 * Every task runs with the platform's GitHub credential, and the allowlist
 * is deployment-wide, so without this check any signed-in account could run
 * a coder against any allowlisted repository — including ones it cannot see.
 * The rule is GitHub's own: a person may ask Atlas to change a repository
 * they can push to, and to read one they can read.
 */
const RANK = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

export function requiredPermission(mode) {
  return mode === "coder" ? "write" : "read";
}

/**
 * @returns {Promise<{ allowed: true } | { allowed: false, status: number, message: string, code: string, blocked: string, unblock?: string }>}
 */
export async function repositoryAccessDecision(account, task, { token, fetcher = fetch }) {
  if (isDeploymentOwner(account)) return { allowed: true };
  const needed = requiredPermission(task.mode);
  if (typeof account?.userId !== "string" || !account.userId.startsWith("github:")) {
    return { allowed: false, status: 403, code: "REPOSITORY_ACCESS_UNVERIFIABLE", blocked: "BLOCKED_BY_PERMISSION", message: "Atlas can only run repository tasks for a signed-in GitHub account, so it can check your access to the repository.", unblock: "Sign in with GitHub." };
  }
  const login = account.userId.slice("github:".length);
  const [owner, repo] = task.repository.split("/");
  let response;
  try {
    response = await fetcher(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(login)}/permission`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "atlas-control-plane", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { allowed: false, status: 502, ...explainGitHubFailure(503), message: "Atlas could not check your access to this repository, so nothing was started." };
  }
  if (response.status === 404) {
    return { allowed: false, status: 403, code: "REPOSITORY_ACCESS_DENIED", blocked: "BLOCKED_BY_PERMISSION", message: `Your GitHub account (${login}) is not a collaborator on ${task.repository}.`, unblock: "Ask the repository owner to add you, or choose a repository you can access." };
  }
  if (!response.ok) {
    const failure = explainGitHubFailure(response.status, { repository: task.repository });
    return { allowed: false, status: 502, ...failure, message: `Atlas could not check your access to this repository: ${failure.message}` };
  }
  const body = await response.json().catch(() => ({}));
  const granted = RANK[body.role_name] !== undefined ? body.role_name : body.permission;
  if ((RANK[granted] ?? 0) >= RANK[needed]) return { allowed: true };
  return {
    allowed: false, status: 403, code: "REPOSITORY_ACCESS_DENIED", blocked: "BLOCKED_BY_PERMISSION",
    message: task.mode === "coder"
      ? `Changing ${task.repository} needs write access, and your GitHub account (${login}) has ${granted ?? "no"} access.`
      : `Reading ${task.repository} needs at least read access, and your GitHub account (${login}) has none.`,
    unblock: task.mode === "coder" ? "Start a review instead, or ask the owner for write access." : "Ask the repository owner for access.",
  };
}
