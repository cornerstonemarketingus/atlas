import { getD1 } from "../../../../../db";
import { NO_TENANT_MESSAGE, resolveTenantContext } from "../../../auth/tenant-context.mjs";
import { authenticatedAccount } from "../../operator-auth.mjs";
import { createInstallationToken, githubAppConfiguration } from "../../github-app.mjs";
import { platformGitHubToken } from "../../github-token.mjs";
import { fetchGitHubJson, githubReadHeaders, workflowRunRequest } from "../../github-runs.mjs";
import { activityFromRun, runBelongsToTask } from "../../run-activity.mjs";

/**
 * Live steps of one task's run, for the chat timeline. The task must belong
 * to the caller's workspace, and the run must carry that task's id in its
 * name, so a guessed run id cannot expose someone else's run.
 */
export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const { taskId } = await context.params;
  if (!/^[0-9a-f-]{36}$/u.test(taskId)) return Response.json({ message: "Unknown task." }, { status: 404 });
  const d1 = getD1();
  const tenant = await resolveTenantContext(request, account, d1);
  if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
  const row = await d1.prepare("SELECT repository, github_run_id AS githubRunId FROM tasks WHERE task_id = ? AND tenant_id = ? AND requested_by = ?")
    .bind(taskId, tenant.tenantId, account.userId).first<{ repository: string; githubRunId: number | null }>();
  if (!row) return Response.json({ message: "Unknown task." }, { status: 404 });

  const requested = Number(new URL(request.url).searchParams.get("runId"));
  const runId = row.githubRunId ?? (Number.isSafeInteger(requested) && requested > 0 ? requested : null);
  if (runId === null) return Response.json({ status: "queued", conclusion: null, url: null, steps: [] }, { headers: { "cache-control": "no-store" } });

  let token = platformGitHubToken();
  try {
    const app = githubAppConfiguration();
    if (app.configured) token = await createInstallationToken(app);
  } catch { /* fall back to the platform token, or report unavailable below */ }
  if (!token) return Response.json({ message: "Live progress is unavailable: no GitHub credential." }, { status: 503 });

  const run = await fetchGitHubJson(workflowRunRequest({ token, repository: row.repository, runId }));
  if (!run || !runBelongsToTask(run, taskId)) return Response.json({ message: "Unknown task." }, { status: 404 });
  const jobs = await fetchGitHubJson({ url: `https://api.github.com/repos/${row.repository}/actions/runs/${runId}/jobs?per_page=10`, init: { method: "GET", headers: githubReadHeaders(token) } });
  return Response.json(activityFromRun(run, jobs ?? {}), { headers: { "cache-control": "no-store" } });
}
