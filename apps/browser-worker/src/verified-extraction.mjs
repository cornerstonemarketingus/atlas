import { verifyArtifact } from "../../local-control/src/platform/executor.mjs";
import { verifyExtraction } from "./verify.mjs";

/**
 * The first end-to-end slice of the platform (blueprint §21): one agent opens
 * a page, extracts a value and returns an artifact that is verified by a
 * deterministic check rather than by anyone's say-so.
 *
 * The "agent" here is scripted, not a model: every step is a fixed tool call
 * so the slice proves the plumbing — task lifecycle, policy, budget, audit
 * events, worker isolation and artifact verification — without depending on
 * a model choosing the right tool. Every step still goes through the
 * AuthorizedToolExecutor, exactly as a model-driven agent's calls would.
 *
 * `store` and `executor` are the platform core's PlatformTaskStore and
 * AuthorizedToolExecutor; the executor must already have the browser tools
 * registered.
 */
export async function runVerifiedExtraction({
  store,
  executor,
  tenantId,
  userId,
  agentId,
  objective,
  startUrl,
  allowedOrigins,
  navigateSteps = [],
  fields,
  expected,
  grantedPermissions,
  budget = { toolCalls: 12, wallTimeMs: 120_000 },
  correlationId,
}) {
  const task = store.createTask({
    tenantId, userId, agentId, objective, correlationId, budget,
    successCriteria: Object.entries(expected).map(([field, rule]) => (
      typeof rule === "string" ? `field '${field}' equals '${rule}'` : `field '${field}' matches /${rule.pattern}/`
    )),
  });
  const actor = { actor: userId };
  for (const to of ["authorized", "queued", "running"]) {
    store.transitionTask(tenantId, task.id, to, { reason: `single-agent extraction: ${to}`, ...actor });
  }

  const call = async (tool, input) => {
    const outcome = await executor.invoke({ tenantId, userId, agentId, taskId: task.id, tool, input, grantedPermissions });
    if (outcome.status !== "succeeded") {
      const reason = outcome.result?.error?.message ?? outcome.decision?.reasons?.join("; ") ?? outcome.status;
      const error = new Error(`${tool} did not succeed (${outcome.status}): ${reason}`);
      error.code = "STEP_FAILED";
      error.outcome = outcome;
      throw error;
    }
    return outcome.result.output;
  };

  // The session is closed while the task is still running: the executor only
  // runs tools for a running task, so closing after the task finished would
  // be refused and leave the browser open until its wall-clock limit.
  let sessionId = null;
  const closeSession = async () => {
    if (!sessionId) return;
    const id = sessionId;
    sessionId = null;
    await call("browser.close_session", { sessionId: id });
  };

  try {
    ({ sessionId } = await call("browser.create_session", { allowedOrigins }));
    await call("browser.navigate", { sessionId, url: startUrl });
    for (const target of navigateSteps) await call("browser.click", { sessionId, target });
    const extraction = await call("browser.extract", { sessionId, fields });
    const screenshot = await call("browser.screenshot", { sessionId });
    await closeSession();

    store.transitionTask(tenantId, task.id, "verifying", { reason: "extraction finished; verifying", ...actor });
    const artifact = store.submitArtifact({
      tenantId, taskId: task.id, kind: "extraction", mediaType: "application/json",
      content: { url: extraction.url ?? null, values: extraction.values, untrusted: true, screenshotDigest: screenshot.digest },
    });
    const verified = await verifyArtifact(store, {
      tenantId, artifactId: artifact.id,
      check: (stored) => verifyExtraction({ artifactContent: stored.content, expected }),
    });

    const ok = verified.verification === "verified";
    store.transitionTask(tenantId, task.id, ok ? "completed" : "failed", {
      reason: ok ? "artifact verified against the declared success criteria" : "artifact failed verification",
      ...actor,
      ...(ok ? { result: { artifactId: artifact.id } } : { error: { code: "VERIFICATION_FAILED", message: "The extracted values did not meet the success criteria." } }),
    });
    return { task: store.getTask(tenantId, task.id), artifact: verified };
  } catch (error) {
    // Best effort: a budget or policy refusal can also refuse the close, in
    // which case the worker's own wall-clock limit ends the session.
    await closeSession().catch(() => {});
    const current = store.getTask(tenantId, task.id);
    if (current && !["completed", "failed", "cancelled", "archived"].includes(current.status)) {
      store.transitionTask(tenantId, task.id, "failed", {
        reason: "a step failed", ...actor,
        error: { code: error.code ?? "STEP_FAILED", message: String(error.message).slice(0, 500) },
      });
    }
    throw error;
  }
}
