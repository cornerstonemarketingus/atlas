import { createRemoteJWKSet, jwtVerify } from "jose";

export const RUNNER_AUDIENCE = "atlas-runner-results";
const keys = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

export async function verifyRunnerIdentity(token, keySet = keys) {
  const { payload } = await jwtVerify(token, keySet, {
    issuer: "https://token.actions.githubusercontent.com",
    audience: RUNNER_AUDIENCE,
    algorithms: ["RS256"],
    maxTokenAge: "10m",
  });
  if (payload.event_name !== "workflow_dispatch" || payload.ref !== "refs/heads/main"
    || !/^\d+$/.test(String(payload.run_id)) || !/^\d+$/.test(String(payload.run_attempt))) {
    throw new Error("Untrusted runner identity");
  }
  return payload;
}

export function validateRunnerResult(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.taskId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.taskId)
    || typeof body.summary !== "string" || !body.summary.trim() || body.summary.length > 16000) {
    throw new Error("Invalid runner result");
  }
  return { taskId: body.taskId, summary: body.summary };
}

/** Bind the signed identity to an exact dispatch, never a time-based guess. */
export function resultBelongsToTask(identity, task, run) {
  const workflow = task.mode === "coder" ? "atlas-coder.yml" : "atlas-runner.yml";
  return task.executionProvider === "managed"
    && identity.repository === task.repository
    && identity.workflow_ref === `${task.repository}/.github/workflows/${workflow}@refs/heads/main`
    && run?.event === "workflow_dispatch"
    && run?.head_branch === "main"
    && String(run?.id) === String(identity.run_id)
    && String(run?.run_attempt) === String(identity.run_attempt)
    && run?.path === `.github/workflows/${workflow}`
    && run?.display_title === `${task.mode === "coder" ? "Atlas Coder" : "Atlas Runner"} · task ${task.taskId}`
    && (task.githubRunId === null || task.githubRunId === Number(identity.run_id));
}
