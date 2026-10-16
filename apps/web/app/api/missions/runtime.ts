import { getD1 } from "../../../db";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";
import { resolveTenantContext, tenantScope } from "../auth/tenant-context.mjs";
import { POST as startTask } from "../tasks/route";
import { createInstallationToken, githubAppConfiguration } from "../tasks/github-app.mjs";
import { platformGitHubToken } from "../tasks/github-token.mjs";
import { fetchGitHubJson, workflowRunRequest } from "../tasks/github-runs.mjs";
import { runBelongsToTask } from "../tasks/run-activity.mjs";
import { missionRoutes } from "./http.mjs";

type Scope = { tenantId: number; principal: string };
type Step = { repository: string; branch: string; mode: string; objective: string; correlationId: string };
function forwarded(request: Request, path: string, body?: object, correlationId?: string) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  if (correlationId) headers.set("x-atlas-correlation-id", correlationId);
  return new Request(new URL(path, request.url), { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}
export const handleMission = missionRoutes({
  authenticate: authenticatedAccount,
  database: getD1,
  resolveScope: async (request: Request, account: Parameters<typeof resolveTenantContext>[1], db: D1Database) => {
    const tenant = await resolveTenantContext(request, account, db);
    return tenant ? tenantScope(tenant) : null;
  },
  dispatch: async (request: Request, _scope: Scope, step: Step) => {
    const response = await startTask(forwarded(request, "/api/tasks", { repository: step.repository, branch: step.branch, mode: step.mode, objective: step.objective }, step.correlationId));
    if (!response.ok) {
      const rejected = [400, 401, 402, 403, 404, 422, 429].includes(response.status);
      const detail = rejected ? await response.json().catch(() => ({})) as { message?: string } : {};
      return { rejected, ...(typeof detail.message === "string" ? { message: detail.message.slice(0, 500) } : {}) };
    }
    return response.json();
  },
  receipt: async (_request: Request, scope: Scope, correlationId: string, step: Step) => {
    const rows = await getD1().prepare("SELECT task_id AS taskId FROM tasks WHERE tenant_id=? AND requested_by=? AND correlation_id=? AND repository=? AND branch=? AND mode=? AND objective=? LIMIT 2")
      .bind(scope.tenantId, scope.principal, correlationId, step.repository, step.branch, step.mode, step.objective).all<{ taskId: string }>();
    return rows.results.length === 1 ? rows.results[0] : null;
  },
  outcome: async (_request: Request, scope: Scope, taskId: string, step: Step) => {
    const task = await getD1().prepare("SELECT github_run_id AS runId FROM tasks WHERE task_id=? AND tenant_id=? AND requested_by=? AND correlation_id=? AND repository=? AND branch=? AND mode=? AND objective=?")
      .bind(taskId, scope.tenantId, scope.principal, step.correlationId, step.repository, step.branch, step.mode, step.objective).first<{ runId: number | null }>();
    if (!task?.runId) return { status: "pending" };
    let run;
    try {
      const app = githubAppConfiguration();
      const token = app.configured ? await createInstallationToken(app) : platformGitHubToken();
      if (!token) return { status: "pending" };
      run = await fetchGitHubJson(workflowRunRequest({ token, repository: step.repository, runId: task.runId }));
    } catch { return { status: "pending" }; }
    if (!run || Number(run.id) !== Number(task.runId) || !runBelongsToTask(run, taskId) || run.status !== "completed" || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return { status: "pending" };
    const receiptId = ["result", taskId, run.id, run.run_attempt].join(":");
    const result = await getD1().prepare("SELECT id, detail FROM run_events WHERE id=? AND task_id=? AND requested_by=? AND kind='result'")
      .bind(receiptId, taskId, scope.principal).first<{ id: string; detail: string | null }>();
    if (run.conclusion === "success" && !result) return { status: "pending" };
    return { status: run.conclusion === "success" ? "completed" : "failed",
      evidence: { taskId, runId: run.id, runAttempt: run.run_attempt, runUrl: run.html_url ?? null, conclusion: run.conclusion, receiptId: result?.id ?? null, summary: (result?.detail ?? "").slice(0, 2000), checkedAt: new Date().toISOString() } };
  },
});
