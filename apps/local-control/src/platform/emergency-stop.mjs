import { ACTIVE_STATES as GENESIS_ACTIVE_STATES } from "./genesis/lifecycle.mjs";

/**
 * The daemon-wide half of the command center's emergency stop.
 *
 * POST /v1/platform/emergency-stop cancels the platform task store's tasks
 * and approvals itself, then calls this hook so the work that runs outside
 * that store stops too:
 *
 *   automations  every enabled automation paused (durably), folder watchers
 *                closed, the schedule timer stopped
 *   missions     every running or queued mission cancelled (coder lanes and
 *                team missions; running children get an abort signal)
 *   sessions     every agent session run cancelled; queued sessions and
 *                sessions waiting on an approval cancelled
 *   genesis      every project build in an active stage paused
 *   renders      every render container in flight removed
 *   compute      every compute lease (Atlas Nodes and rented GPUs) ended and settled
 *   nodes        every Atlas Node job still queued or claimed cancelled; a
 *                node holding one loses its claim
 *   terminal     every terminal command an agent started killed
 *   approvals    every pending approval in the local inbox denied, with the
 *                same consequences as the owner denying it
 *
 * Each service is stopped independently: one that throws is reported as
 * failed and the rest still stop. A service this daemon is not running is
 * reported as "not_running". Pressing stop again stops nothing new, and two
 * presses at once share one stop.
 */
export function createEmergencyStop({
  store,
  missionService = null,
  runtime = null,
  genesis = null,
  automations = null,
  render = null,
  compute = null,
  nodes = null,
  terminal = null,
  onApprovalDecided = null,
  now = () => new Date(),
}) {
  if (!store) throw new TypeError("createEmergencyStop needs the local task store.");
  let inFlight = null;

  async function stopEverything({ actor = "owner", reason = "emergency stop" } = {}) {
    const services = {};
    const step = async (name, available, run) => {
      if (!available) {
        services[name] = { status: "not_running", stopped: [], failed: [] };
        return;
      }
      try {
        const { stopped = [], failed = [], ...details } = (await run()) ?? {};
        const status = failed.length ? (stopped.length ? "partial" : "failed") : stopped.length ? "stopped" : "idle";
        services[name] = { status, stopped, failed, ...details };
      } catch (error) {
        services[name] = { status: "failed", stopped: [], failed: [{ error: message(error) }] };
      }
    };

    // New work first: nothing may start while the rest is being stopped.
    await step("automations", automations, () => {
      const result = automations.halt(`Paused by ${reason}.`);
      return { stopped: result.paused, failed: result.failed, watchersStopped: result.watchersStopped, schedulerStopped: result.schedulerStopped };
    });
    await step("missions", missionService, () => {
      const result = missionService.cancelAll(`Cancelled by ${reason}.`);
      return { stopped: result.cancelled, failed: result.failed };
    });
    await step("sessions", runtime, () => {
      const result = runtime.cancelAll(reason);
      return { stopped: result.cancelled, failed: result.failed };
    });
    await step("genesis", genesis, () => {
      const stopped = [];
      const failed = [];
      for (const project of genesis.list()) {
        if (!GENESIS_ACTIVE_STATES.includes(project.state)) continue;
        try {
          genesis.pause(project.id, { actor, reason: `Paused by ${reason}.` });
          stopped.push(project.id);
        } catch (error) {
          failed.push({ id: project.id, error: message(error) });
        }
      }
      return { stopped, failed };
    });
    await step("renders", render && typeof render.cancelAll === "function", () => ({ stopped: render.cancelAll(reason).cancelled }));
    await step("compute", compute?.enabled && compute.manager, async () => {
      const result = await compute.manager.terminateAll("emergency_stop");
      return { stopped: result.ended, failed: result.failed };
    });
    // After compute, so jobs a lease owned are already ended; this catches the rest.
    await step("nodes", nodes && typeof nodes.listLiveJobs === "function", () => {
      const stopped = [];
      const failed = [];
      for (const job of nodes.listLiveJobs()) {
        if (!["queued", "claimed"].includes(job.state)) continue;
        try {
          if (nodes.terminate(job.id, "emergency_stop")?.state === "cancelled") stopped.push(job.id);
        } catch (error) {
          failed.push({ id: job.id, error: message(error) });
        }
      }
      return { stopped, failed };
    });
    await step("terminal", terminal && typeof terminal.cancelRunning === "function", async () => {
      const result = await terminal.cancelRunning();
      return { stopped: result.cancelled, failed: result.failed };
    });
    // Last, so an approval requested while the rest was stopping is denied too.
    await step("approvals", true, async () => {
      const stopped = [];
      const failed = [];
      for (const pending of store.approvals().filter((approval) => approval.status === "pending")) {
        try {
          const approval = store.decideApproval(pending.id, "denied", { reason });
          if (!approval) continue;
          if (approval.taskId) store.finish(approval.taskId, "failed", `Denied by ${reason}.`);
          if (approval.sessionId && runtime) {
            try { runtime.denyApproval(approval.sessionId, `${approval.summary} (denied by ${reason})`); } catch { /* the session was already cancelled above */ }
          }
          if (onApprovalDecided) await onApprovalDecided(approval);
          stopped.push(pending.id);
        } catch (error) {
          failed.push({ id: pending.id, error: message(error) });
        }
      }
      return { stopped, failed };
    });

    const entries = Object.entries(services);
    const summary = {
      stoppedAt: now().toISOString(),
      reason,
      ok: entries.every(([, service]) => service.failed.length === 0),
      stopped: entries.reduce((total, [, service]) => total + service.stopped.length, 0),
      failed: entries.reduce((total, [, service]) => total + service.failed.length, 0),
      services,
    };
    try {
      store.audit("emergency_stop.services", `${actor}: ${entries.map(([name, service]) => `${name} ${service.status}${service.stopped.length ? ` ${service.stopped.length}` : ""}${service.failed.length ? ` (${service.failed.length} failed)` : ""}`).join(", ")} — ${reason}`);
    } catch {
      summary.ok = false;
      summary.auditFailed = true;
    }
    return summary;
  }

  return function emergencyStop(input = {}) {
    inFlight ??= stopEverything(input).finally(() => { inFlight = null; });
    return inFlight;
  };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
