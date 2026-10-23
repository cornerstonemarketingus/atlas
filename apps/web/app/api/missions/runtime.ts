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
    if (!githubAppConfiguration().configured && !platformGitHubToken()) return { rejected: true, message: "Cloud missions require managed GitHub Actions execution. Configure the managed runner before starting a mission." };
    const response = await startTask(forwarded(request, "/api/tasks", { repository: step.repository, branch: step.branch, mode: step.mode, objective: step.objective }, step.correlationId));
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { message?: string; status?: string; recorded?: boolean; runner?: string; correlationId?: string };
      const rejected = [400, 401, 402, 403, 404, 422, 429].includes(response.status)
        || (detail.status === "dispatch-rejected" && detail.recorded === true && detail.runner === "managed" && detail.correlationId === step.correlationId);
      return { rejected, ...(rejected && typeof detail.message === "string" ? { message: detail.message.slice(0, 500) } : {}) };
    }
    const result = await response.json() as { taskId?: string; correlationId?: string; runner?: string; recorded?: boolean; status?: string };
    if (result.runner !== "managed" || result.recorded !== true) return { ...result, recorded: false, message: result.runner !== "managed"
      ? "Work was accepted by an unsupported runner. Its outcome cannot be verified here; no retry was sent."
      : "Work was accepted, but its durable task receipt was not confirmed. Reconcile before continuing; no retry was sent." };
    return result.status === "dispatch-unknown" ? { ...result, uncertain: true, message: "The saved dispatch outcome is uncertain. Reconcile its run before continuing; no retry was sent." } : result;
  },
  receipt: async (_request: Request, scope: Scope, correlationId: string, step: Step) => {
    const rows = await getD1().prepare("SELECT * FROM tasks WHERE execution_provider='managed' AND tenant_id=? AND requested_by=? AND correlation_id=? AND repository=? AND branch=? AND mode=? AND objective=? LIMIT 2")
      .bind(scope.tenantId, scope.principal, correlationId, step.repository, step.branch, step.mode, step.objective).all<{ task_id: string; dispatch_state?: string; github_run_id: number | null }>();
    const row = rows.results.length === 1 ? rows.results[0] : null;
    if (!row) return null;
    if (row.dispatch_state === "rejected") return { taskId: row.task_id, rejected: true };
    if (["recorded", "dispatching", "unknown"].includes(row.dispatch_state ?? "") && !row.github_run_id) return null;
    return { taskId: row.task_id };
  },
  outcome: async (_request: Request, scope: Scope, taskId: string, step: Step) => {
    const task = await getD1().prepare("SELECT github_run_id AS runId FROM tasks WHERE execution_provider='managed' AND task_id=? AND tenant_id=? AND requested_by=? AND correlation_id=? AND repository=? AND branch=? AND mode=? AND objective=?")
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
    // A completed status without a recognized conclusion is incomplete evidence.
    if (!["success", "failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"].includes(run.conclusion)) return { status: "pending" };
    const receiptId = ["result", taskId, run.id, run.run_attempt].join(":");
    const result = await getD1().prepare("SELECT id, detail FROM run_events WHERE id=? AND task_id=? AND requested_by=? AND kind='result'")
      .bind(receiptId, taskId, scope.principal).first<{ id: string; detail: string | null }>();
    if (run.conclusion === "success" && !result) return { status: "pending" };
    return { status: run.conclusion === "success" ? "completed" : "failed",
      evidence: { taskId, runId: run.id, runAttempt: run.run_attempt, runUrl: run.html_url ?? null, conclusion: run.conclusion, receiptId: result?.id ?? null, summary: (result?.detail ?? "").slice(0, 2000), checkedAt: new Date().toISOString() } };
  },
});
