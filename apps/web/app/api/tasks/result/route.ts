import { getD1 } from "../../../../db";
import { createInstallationToken, githubAppConfiguration } from "../github-app.mjs";
import { correlationMatchesTask, resultBelongsToTask, validateRunnerResult, verifyRunnerIdentity } from "../runner-result.mjs";
import { verifyExecutionOutcome } from "../execution-outcomes.mjs";
import { saveRunnerResult } from "../result-storage.mjs";
import { EXECUTOR_REPOSITORY_ID } from "../execution-claims.mjs";
import { platformGitHubToken } from "../github-token.mjs";

export async function POST(request: Request) {
  let identity;
  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 16000) throw new Error();
    identity = await verifyRunnerIdentity(authorization.slice(7));
  } catch { return Response.json({ message: "Runner authentication required." }, { status: 401 }); }
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
  } catch { return Response.json({ message: "Invalid result payload." }, { status: 400 }); }
  try {
    const d1 = getD1();
    const task = await d1.prepare("SELECT task_id AS taskId, tenant_id AS tenantId, requested_by AS requestedBy, repository, branch, mode, objective, merge_policy AS mergePolicy, correlation_id AS correlationId, execution_provider AS executionProvider, dispatch_state AS dispatchState, conversation_id AS conversationId, github_run_id AS githubRunId FROM tasks WHERE task_id = ?").bind(body.taskId).first();
    if (!task?.conversationId || identity.repository !== task.repository) return Response.json({ message: "Dispatch not found." }, { status: 404 });
    if (task.dispatchState !== "legacy" && identity.repository_id !== EXECUTOR_REPOSITORY_ID) return Response.json({ message: "Executor identity does not match dispatch." }, { status: 403 });
    // Checked before the GitHub round-trip: a positive mismatch can never be
    // this task's result, whatever the run verification would say.
    if (!correlationMatchesTask(body, task)) return Response.json({ message: "Result correlation id does not match dispatch." }, { status: 409 });
    const app = githubAppConfiguration();
    const token = app.configured ? await createInstallationToken(app) : platformGitHubToken();
    if (!token) return Response.json({ message: "Run verification unavailable." }, { status: 503 });
    const response = await fetch(`https://api.github.com/repos/${task.repository}/actions/runs/${identity.run_id}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "atlas-control-plane" },
      redirect: "manual", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return Response.json({ message: "Run verification unavailable." }, { status: 503 });
    const run = await response.json();
    if (!resultBelongsToTask(identity, task, run)) return Response.json({ message: "Result does not match dispatch." }, { status: 403 });
    const outcome = task.dispatchState === "legacy" ? null : await verifyExecutionOutcome(identity, task, run, token);
    // Recheck task, tenant, conversation and exact claim inside every write.
    if (!await saveRunnerResult(d1, task, identity, body.summary, new Date().toISOString(), outcome)) return Response.json({ message: "Result execution ownership does not match dispatch." }, { status: 409 });
    const correlationId = task.correlationId ?? body.correlationId ?? null;
    return Response.json({ received: true, ...(correlationId ? { correlationId } : {}) }, correlationId ? { headers: { "x-atlas-correlation-id": correlationId } } : undefined);
  } catch { return Response.json({ message: "Result storage temporarily unavailable." }, { status: 503 }); }
}
