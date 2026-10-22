import { getD1 } from "../../../../db";
import { createInstallationToken, githubAppConfiguration } from "../github-app.mjs";
import { correlationMatchesTask, resultBelongsToTask, validateRunnerResult, verifyRunnerIdentity } from "../runner-result.mjs";
import { verifyExecutionOutcome } from "../execution-outcomes.mjs";
import { saveRunnerResult } from "../result-storage.mjs";
import { EXECUTOR_REPOSITORY_ID } from "../execution-claims.mjs";
import { platformGitHubToken } from "../github-token.mjs";

// Fixed codes let the runner diagnose reporting failures without exposing
// upstream response bodies, token details or SQL errors.
function failure(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status, headers: { "x-atlas-result-error": code } });
}

export async function POST(request: Request) {
  let identity;
  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 16000) throw new Error();
    identity = await verifyRunnerIdentity(authorization.slice(7));
  } catch { return failure(401, "RUNNER_AUTHENTICATION_REQUIRED", "Runner authentication required."); }
  let body;
  try {
    // Bound the stream as well as Content-Length (which is optional/untrusted).
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64000) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = validateRunnerResult(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { return failure(400, "INVALID_RESULT_PAYLOAD", "Invalid result payload."); }
  try {
    const d1 = getD1();
    const task = await d1.prepare("SELECT task_id AS taskId, tenant_id AS tenantId, requested_by AS requestedBy, repository, branch, mode, objective, merge_policy AS mergePolicy, correlation_id AS correlationId, execution_provider AS executionProvider, dispatch_state AS dispatchState, conversation_id AS conversationId, github_run_id AS githubRunId FROM tasks WHERE task_id = ?").bind(body.taskId).first();
    if (!task?.conversationId || identity.repository !== task.repository) return failure(404, "DISPATCH_NOT_FOUND", "Dispatch not found.");
    if (task.dispatchState !== "legacy" && identity.repository_id !== EXECUTOR_REPOSITORY_ID) return failure(403, "EXECUTOR_IDENTITY_MISMATCH", "Executor identity does not match dispatch.");
    // Checked before the GitHub round-trip: a positive mismatch can never be
    // this task's result, whatever the run verification would say.
    if (!correlationMatchesTask(body, task)) return failure(409, "RESULT_CORRELATION_MISMATCH", "Result correlation id does not match dispatch.");
    let token;
    let run;
    try {
      const app = githubAppConfiguration();
      token = app.configured ? await createInstallationToken(app) : platformGitHubToken();
      if (!token) return failure(503, "GITHUB_VERIFICATION_CREDENTIAL_MISSING", "Run verification credential unavailable.");
      const response = await fetch(`https://api.github.com/repos/${task.repository}/actions/runs/${identity.run_id}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "atlas-control-plane" },
        redirect: "manual", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* no upstream details surfaced */ }
        return failure(503, "GITHUB_RUN_VERIFICATION_UNAVAILABLE", "Run verification unavailable.");
      }
      run = await response.json();
    } catch { return failure(503, "GITHUB_RUN_VERIFICATION_UNAVAILABLE", "Run verification unavailable."); }
    if (!resultBelongsToTask(identity, task, run)) return failure(403, "RESULT_DISPATCH_MISMATCH", "Result does not match dispatch.");
    let outcome;
    try { outcome = task.dispatchState === "legacy" ? null : await verifyExecutionOutcome(identity, task, run, token); }
    catch { return failure(503, "GITHUB_RUN_VERIFICATION_UNAVAILABLE", "Execution job verification unavailable."); }
    // Recheck task, tenant, conversation and exact claim inside every write.
    if (!await saveRunnerResult(d1, task, identity, body.summary, new Date().toISOString(), outcome)) return failure(409, "RESULT_OWNERSHIP_MISMATCH", "Result execution ownership does not match dispatch.");
    const correlationId = task.correlationId ?? body.correlationId ?? null;
    return Response.json({ received: true, ...(correlationId ? { correlationId } : {}) }, correlationId ? { headers: { "x-atlas-correlation-id": correlationId } } : undefined);
  } catch { return failure(503, "RESULT_STORAGE_UNAVAILABLE", "Result storage temporarily unavailable."); }
}
