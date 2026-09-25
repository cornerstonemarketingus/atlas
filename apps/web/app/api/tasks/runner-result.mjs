import { createRemoteJWKSet, jwtVerify } from "jose";
import { isCorrelationId } from "./correlation.mjs";

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
  // Optional for backward compatibility with runners that predate correlation
  // ids; when present it must be exactly the shape Atlas issues.
  if (body.correlationId !== undefined && body.correlationId !== null && !isCorrelationId(body.correlationId)) {
    throw new Error("Invalid runner result");
  }
  return isCorrelationId(body.correlationId)
    ? { taskId: body.taskId, summary: body.summary, correlationId: body.correlationId }
    : { taskId: body.taskId, summary: body.summary };
}

/**
 * A result that names a correlation id must name the one stored with its
 * task. Either side missing (older task rows, older runners) is accepted, so
 * this only ever refuses a positive mismatch.
 */
export function correlationMatchesTask(result, task) {
  const reported = result?.correlationId ?? null;
  const stored = task?.correlationId ?? null;
  if (!reported || !stored) return true;
  return reported === stored;
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
