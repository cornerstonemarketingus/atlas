import { getD1 } from "../../../../../db";
import { NO_TENANT_MESSAGE, resolveTenantContext } from "../../../auth/tenant-context.mjs";
import { authenticatedAccount } from "../../operator-auth.mjs";
import { createInstallationToken, githubAppConfiguration } from "../../github-app.mjs";
import { platformGitHubToken } from "../../github-token.mjs";
import { fetchGitHubJson, githubReadHeaders, pullRequestForBranchRequest } from "../../github-runs.mjs";
import { coderBranchForTask } from "../../run-status.mjs";
import { changedFilesFrom } from "../../pr-changes.mjs";

/**
 * The files a coder task changed, with diffs, for the chat and the Files
 * panel. The task must belong to the caller's workspace; the pull request is
 * found by the task's own coder branch, never by a number from the client.
 */
export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const { taskId } = await context.params;
  if (!/^[0-9a-f-]{36}$/u.test(taskId)) return Response.json({ message: "Unknown task." }, { status: 404 });
  const d1 = getD1();
  const tenant = await resolveTenantContext(request, account, d1);
  if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
  const row = await d1.prepare("SELECT repository, mode FROM tasks WHERE task_id = ? AND tenant_id = ? AND requested_by = ?")
    .bind(taskId, tenant.tenantId, account.userId).first<{ repository: string; mode: string }>();
  if (!row) return Response.json({ message: "Unknown task." }, { status: 404 });
  const empty = { pullRequest: null, files: [], additions: 0, deletions: 0 };
  if (row.mode !== "coder") return Response.json(empty, { headers: { "cache-control": "no-store" } });

  // The GitHub App installation may not be granted pull-request reads (see pullRequestForBranchRequest), so the platform token is tried too.
  const tokens: string[] = [];
  try {
    const app = githubAppConfiguration();
    if (app.configured) tokens.push(await createInstallationToken(app));
  } catch { /* fall back to the platform token */ }
  const platform = platformGitHubToken();
  if (platform) tokens.push(platform);
  if (!tokens.length) return Response.json({ message: "Changed files are unavailable: no GitHub credential." }, { status: 503 });

  let pull: { number?: unknown; html_url?: unknown; title?: unknown } | null = null;
  let token = tokens[0];
  for (const candidate of tokens) {
    const pulls = await fetchGitHubJson(pullRequestForBranchRequest({ token: candidate, repository: row.repository, branch: coderBranchForTask(taskId) }));
    if (Array.isArray(pulls)) { pull = pulls[0] ?? null; token = candidate; break; }
  }
  if (!pull || !Number.isInteger(pull.number)) return Response.json(empty, { headers: { "cache-control": "no-store" } });
  const files = await fetchGitHubJson({ url: `https://api.github.com/repos/${row.repository}/pulls/${pull.number}/files?per_page=100`, init: { method: "GET", headers: githubReadHeaders(token) } });
  return Response.json({
    pullRequest: { number: pull.number, url: typeof pull.html_url === "string" ? pull.html_url : null, title: typeof pull.title === "string" ? pull.title : "" },
    ...changedFilesFrom(files),
  }, { headers: { "cache-control": "no-store" } });
}
