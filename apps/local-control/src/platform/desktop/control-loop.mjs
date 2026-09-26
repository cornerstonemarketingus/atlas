import { DesktopError, RECOVERABLE_CODES, TERMINAL_CODES } from "./errors.mjs";

/**
 * observe -> plan -> policy check -> execute -> observe -> verify -> continue | recover | escalate
 *
 * The planner is injected: `planner({ goal, observation, history, step })`
 * returns one of
 *   { done: true, result }
 *   { escalate: "reason" }
 *   { action: { type, target?, x?, y?, text?, key?, dx?, dy?, windowId?, app? },
 *     postcondition?: (observation) => boolean, description? }
 *
 * The policy check is the controller's pipeline (session, scope, policy
 * hook), which runs on every execute; a refusal there is never retried.
 *
 * Recovery is deliberately narrow: when the target was stale / missing, or
 * the postcondition failed after the action, the loop re-observes, re-locates
 * the element by its accessible role + name (and app), and retries once with
 * a fresh ref. If that also fails, it escalates to a human instead of
 * guessing further.
 */

const ACTIONS = {
  click: (c, id, a, o) => c.click(id, { target: a.target, x: a.x, y: a.y, button: a.button }, o),
  move: (c, id, a, o) => c.move(id, { x: a.x, y: a.y }, o),
  typeText: (c, id, a, o) => c.typeText(id, { text: a.text, target: a.target }, o),
  keyPress: (c, id, a, o) => c.keyPress(id, { key: a.key, target: a.target }, o),
  scroll: (c, id, a, o) => c.scroll(id, { dx: a.dx, dy: a.dy }, o),
  focusWindow: (c, id, a, o) => c.focusWindow(id, { windowId: a.windowId, title: a.title }, o),
  launchApp: (c, id, a, o) => c.launchApp(id, { app: a.app }, o),
};

/**
 * Finds an element by accessible name (and optionally role / app) in an
 * observation from `DesktopController.observe` (its `elements` carry refs).
 */
export function findElement(observation, { name, role, app } = {}) {
  if (!name) return null;
  return (observation?.elements ?? []).find((element) => element.name === name
    && (!role || element.role === role)
    && (!app || element.app === String(app).toLowerCase())) ?? null;
}

function describe(action) {
  const { text, ...rest } = action;
  return text === undefined ? rest : { ...rest, text: `[REDACTED ${text.length} chars]` };
}

export async function runControlLoop({
  controller,
  sessionId,
  planner,
  goal,
  maxSteps = 25,
  screenshots = false,
  signal = undefined,
  onEscalate = null,
  onStep = null,
}) {
  if (typeof planner !== "function") throw new DesktopError("INVALID_REQUEST", "The control loop needs a planner function.");
  const history = [];
  const opts = { signal };

  const finish = async (status, extra = {}) => {
    const outcome = { status, steps: history.length, history, ...extra };
    if (status === "escalated" && onEscalate) await onEscalate(outcome);
    return outcome;
  };
  const stopFor = (error) => {
    const code = error?.code ?? "ERROR";
    const status = ["EMERGENCY_STOPPED", "SESSION_EXPIRED", "SESSION_ENDED", "SESSION_REVOKED", "SESSION_PAUSED", "DEVICE_REVOKED", "ABORTED", "NO_SESSION"].includes(code)
      ? "stopped" : "escalated";
    return finish(status, { reason: error?.message ?? String(error), code });
  };

  let observation;
  try {
    observation = await controller.observe(sessionId, { screenshot: screenshots }, opts);
  } catch (error) {
    return stopFor(error);
  }

  for (let step = 0; step < maxSteps; step += 1) {
    let plan;
    try {
      plan = await planner({ goal, observation, history, step });
    } catch (error) {
      return finish("escalated", { reason: `planner failed: ${error?.message ?? error}`, code: "PLANNER_ERROR" });
    }
    if (plan?.done) return finish("completed", { result: plan.result ?? null });
    if (plan?.escalate) return finish("escalated", { reason: String(plan.escalate), code: "PLANNER_ESCALATED" });
    const action = plan?.action;
    const run = ACTIONS[action?.type];
    if (!run) return finish("escalated", { reason: `planner proposed an unsupported action '${action?.type}'`, code: "UNSUPPORTED_ACTION" });

    const entry = { step, action: describe(action), description: plan.description ?? null, attempts: [] };
    history.push(entry);
    onStep?.(entry);

    const attempt = async (candidate) => {
      const coordinateFallback = typeof candidate.target?.ref !== "string" && Number.isFinite(candidate.x);
      try {
        await run(controller, sessionId, candidate, opts);
        entry.attempts.push({ ok: true, coordinateFallback });
        return { ok: true };
      } catch (error) {
        entry.attempts.push({ ok: false, code: error?.code ?? "ERROR", coordinateFallback });
        return { ok: false, error };
      }
    };
    const verify = async () => {
      observation = await controller.observe(sessionId, { screenshot: screenshots }, opts);
      return typeof plan.postcondition === "function" ? Boolean(plan.postcondition(observation)) : true;
    };

    let executed;
    let verified = false;
    try {
      executed = await attempt(action);
      if (!executed.ok && (TERMINAL_CODES.has(executed.error.code) || !RECOVERABLE_CODES.has(executed.error.code))) return stopFor(executed.error);
      if (executed.ok) verified = await verify();
      else observation = await controller.observe(sessionId, { screenshot: screenshots }, opts);
    } catch (error) {
      return stopFor(error);
    }
    if (verified) { entry.verified = true; continue; }

    // Recover once: re-locate by accessible name on the fresh observation.
    const relocated = findElement(observation, action.target ?? {});
    if (!relocated) {
      entry.verified = false;
      return finish("escalated", {
        reason: executed.ok ? "postcondition not met and the target could not be re-located" : `target lost (${executed.error.code}) and could not be re-located`,
        code: "RECOVERY_FAILED",
      });
    }
    const retry = { ...action, target: { ...action.target, ref: relocated.ref } };
    delete retry.x;
    delete retry.y;
    entry.recovered = { by: "accessible_name", name: relocated.name, ref: relocated.ref };
    try {
      const second = await attempt(retry);
      if (!second.ok) {
        if (TERMINAL_CODES.has(second.error.code)) return stopFor(second.error);
        return finish("escalated", { reason: `retry after re-locating failed (${second.error.code})`, code: "RECOVERY_FAILED" });
      }
      verified = await verify();
    } catch (error) {
      return stopFor(error);
    }
    entry.verified = verified;
    if (!verified) return finish("escalated", { reason: "postcondition still not met after one recovery attempt", code: "RECOVERY_FAILED" });
  }
  return finish("escalated", { reason: `step limit of ${maxSteps} reached`, code: "STEP_LIMIT" });
}
