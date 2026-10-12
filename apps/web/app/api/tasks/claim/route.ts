import { getD1 } from "../../../../db";
import { createInstallationToken, githubAppConfiguration } from "../github-app.mjs";
import { platformGitHubToken } from "../github-token.mjs";
import { verifyClaimIdentity, validateExecutionClaim, claimMatchesTask, claimRunMatches, grantTaskExecution } from "../execution-claims.mjs";

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  let identity;
  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 16000) throw new Error();
    identity = await verifyClaimIdentity(authorization.slice(7));
  } catch { return reply({ message: "Trusted executor authentication required." }, 401); }
  let body;
  try {
    const reader = request.body?.getReader(); if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 32768) throw new Error(); chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = validateExecutionClaim(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { return reply({ message: "Invalid execution claim." }, 400); }
  try {
    const d1 = getD1();
    const task = await d1.prepare("SELECT task_id AS taskId, tenant_id AS tenantId, requested_by AS requestedBy, repository, branch, mode, objective, merge_policy AS mergePolicy, correlation_id AS correlationId, execution_provider AS executionProvider, dispatch_state AS dispatchState, conversation_id AS conversationId, github_run_id AS githubRunId FROM tasks WHERE task_id = ?").bind(body.taskId).first();
    if (!task || identity.repository !== task.repository) return reply({ message: "Saved dispatch not found." }, 404);
    if (!claimMatchesTask(body, task)) return reply({ message: "Claim does not match saved dispatch." }, 403);
    const app = githubAppConfiguration();
    const token = app.configured ? await createInstallationToken(app) : platformGitHubToken();
    if (!token) return reply({ message: "Run verification unavailable." }, 503);
    const response = await fetch(`https://api.github.com/repos/${task.repository}/actions/runs/${identity.run_id}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "atlas-control-plane" }, redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) { await response.body?.cancel(); return reply({ message: "Run verification unavailable." }, 503); }
    if (!claimRunMatches(identity, task, await response.json())) return reply({ message: "Run does not match saved dispatch." }, 403);
    const grant = await grantTaskExecution(d1, task, identity);
    return grant ? reply(grant) : reply({ message: "Task execution is already reserved or unavailable. No takeover is permitted." }, 409);
  } catch { return reply({ message: "Execution claim is unavailable. No execution is authorized." }, 503); }
}
