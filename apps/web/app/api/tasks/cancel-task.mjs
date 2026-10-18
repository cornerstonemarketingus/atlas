import { workflowForMode } from "./dispatch.mjs";
import { githubReadHeaders, workflowRunRequest, workflowRunsRequest } from "./github-runs.mjs";
import { runBelongsToTask } from "./run-activity.mjs";

const taskPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// A saved run ID may have come from the historical time-based matcher. Never
// use that heuristic to authorize a write; verify GitHub's exact identity.
export function cancellableRun(run, task, workflow) {
  return Number.isSafeInteger(run?.id) && run.id > 0
    && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
    && run.repository?.full_name?.toLowerCase() === task.repository.toLowerCase()
    && run.event === "workflow_dispatch" && run.head_branch === "main"
    && (String(run.workflow_id) === workflow || run.path === `.github/workflows/${workflow}`)
    && runBelongsToTask(run, task.taskId);
}

/** The production route supplies existing Atlas auth, D1 and GitHub credentials. */
export async function cancelHostedTask(request, taskId, { authenticate, tenantContext, database, githubToken, fetcher = fetch, environment = process.env }) {
  try {
    const account = await authenticate(request);
    if (!account) return reply({ message: "Sign in is required." }, 401);
    const origin = request.headers.get("origin");
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
      return reply({ message: "Cancellation must come from Atlas." }, 403);
    }
    if (!taskPattern.test(taskId)) return reply({ message: "Unknown task." }, 404);
    const d1 = database();
    const tenant = await tenantContext(request, account, d1);
    if (!tenant) return reply({ message: "You are not a member of that workspace." }, 403);
    const task = await d1.prepare("SELECT task_id AS taskId, repository, mode, execution_provider AS executionProvider, github_run_id AS githubRunId, conversation_id AS conversationId FROM tasks WHERE task_id = ? AND tenant_id = ? AND requested_by = ?")
      .bind(taskId, tenant.tenantId, account.userId).first();
    if (!task) return reply({ message: "Unknown task." }, 404);
    if (task.executionProvider !== "managed") return reply({ message: "This executor does not support hosted cancellation." }, 409);
    const token = await githubToken();
    if (!token) return reply({ message: "Run verification is unavailable." }, 503);
    const workflow = workflowForMode(task.mode, { coderWorkflow: environment.ATLAS_CODER_WORKFLOW, defaultWorkflow: environment.ATLAS_GITHUB_WORKFLOW });
    const read = async options => {
      const response = await fetcher(options.url, { ...options.init, redirect: "error", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("Run verification unavailable");
      return response.json();
    };
    let run;
    if (task.githubRunId !== null) {
      run = await read(workflowRunRequest({ token, repository: task.repository, runId: task.githubRunId }));
    } else {
      const listing = await read(workflowRunsRequest({ token, repository: task.repository, workflow, perPage: 100 }));
      const matches = (Array.isArray(listing.workflow_runs) ? listing.workflow_runs : []).filter(item => cancellableRun(item, task, workflow));
      if (matches.length !== 1) return reply({ message: "The task's exact run is not yet available. Refresh its progress before cancelling." }, 409);
      run = matches[0];
    }
    if (!cancellableRun(run, task, workflow) || (task.githubRunId !== null && run.id !== task.githubRunId)) return reply({ message: "The run does not match this task." }, 409);
    if (run.status === "completed") return reply({ taskId, runId: run.id, status: "completed", conclusion: run.conclusion ?? null });
    if (!task.conversationId) return reply({ message: "Cancellation audit storage is unavailable." }, 503);
    const receiptId = `cancel:${taskId}:${run.id}:${run.run_attempt}`;
    // Store intent before touching GitHub. Stable IDs survive retries/restarts.
    const record = async (suffix, label, detail) => {
      const result = await d1.prepare("INSERT INTO run_events (id, conversation_id, task_id, requested_by, kind, label, detail, created_at) SELECT ?, c.id, t.task_id, t.requested_by, 'cancellation', ?, ?, ? FROM tasks t JOIN conversations c ON c.id = t.conversation_id AND c.tenant_id = t.tenant_id AND c.requested_by = t.requested_by WHERE t.task_id = ? AND t.tenant_id = ? AND t.requested_by = ? ON CONFLICT(id) DO NOTHING")
        .bind(`${receiptId}:${suffix}`, label, detail, new Date().toISOString(), taskId, tenant.tenantId, account.userId).run();
      if (result.success === false) throw new Error("Audit unavailable");
      const receipt = await d1.prepare("SELECT id FROM run_events WHERE id = ? AND conversation_id = ? AND requested_by = ?")
        .bind(`${receiptId}:${suffix}`, task.conversationId, account.userId).first();
      if (!receipt) throw new Error("Audit unavailable");
    };
    await record("requested", "Cancellation requested", `Stop hosted run ${run.id}, attempt ${run.run_attempt}.`);
    const accepted = await d1.prepare("SELECT id FROM run_events WHERE id = ? AND conversation_id = ? AND requested_by = ?")
      .bind(`${receiptId}:accepted`, task.conversationId, account.userId).first();
    if (accepted) return reply({ taskId, runId: run.id, status: "cancellation-requested" }, 202);
    let response;
    try {
      // Cancellation is safe to repeat after an uncertain acknowledgement. No
      // rerun, force-cancel or retry of repository operations is performed.
      response = await fetcher(`${workflowRunRequest({ token, repository: task.repository, runId: run.id }).url}/cancel`, {
        method: "POST", headers: githubReadHeaders(token), redirect: "error", signal: AbortSignal.timeout(8000),
      });
      try { await response.body?.cancel(); } catch { /* no provider text is exposed */ }
    } catch {
      return reply({ taskId, runId: run.id, status: "cancellation-unknown", message: "The cancellation response was lost. Check live progress; cancellation can be safely requested again." }, 202);
    }
    if (response.status !== 202) {
      return reply({ taskId, runId: run.id, status: "cancellation-unknown", message: "GitHub did not confirm cancellation. Check live progress before retrying." }, response.status >= 500 || response.status === 409 ? 202 : 502);
    }
    try { await record("accepted", "Cancellation accepted", `GitHub accepted cancellation of run ${run.id}, attempt ${run.run_attempt}. Live progress confirms when it stops.`); }
    catch { return reply({ taskId, runId: run.id, status: "cancellation-unknown", message: "GitHub accepted cancellation, but its receipt could not be saved. Check live progress." }, 202); }
    return reply({ taskId, runId: run.id, status: "cancellation-requested" }, 202);
  } catch {
    return reply({ message: "Cancellation is temporarily unavailable. No stopped state is inferred." }, 503);
  }
}
