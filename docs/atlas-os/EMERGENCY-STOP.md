# Emergency stop (local daemon)

The red **Emergency stop** button on the local command center (`/platform`)
calls `POST /v1/platform/emergency-stop` with `{ "confirm": true, "reason": "…" }`
(owner token only). It stops every kind of work the daemon runs, not only the
platform task store.

## What it stops

The route (`apps/local-control/src/platform/api-routes.mjs`) first cancels the
platform task store's in-flight tasks, rejects that store's pending approvals,
idles running family agents and cancels their delegations. It then calls the
daemon-wide hook, `createEmergencyStop` in
`apps/local-control/src/platform/emergency-stop.mjs`, which `main.mjs` passes as
`platformServices.onEmergencyStop`. The hook stops, in this order:

| Service | What happens | API used |
|---|---|---|
| `automations` | Every enabled automation is paused (durably, reason recorded, so a restart does not re-arm it); every folder watcher is closed; the schedule timer is stopped. | `AutomationService.halt()` |
| `missions` | Every running or queued mission (coder lanes and team missions) is cancelled with the reason; running children get an abort signal. Missions the owner already paused are left resumable. | `MissionService.cancelAll()` |
| `sessions` | Every agent session run in flight is cancelled; queued sessions and sessions waiting on an approval are cancelled. | `AgentRuntime.cancelAll()` |
| `genesis` | Every project in an active build stage is paused (a hold the owner can resume). | `GenesisService.pause()` |
| `renders` | Every render container in flight is removed; the job ends `cancelled` and its outputs are discarded. | `RenderRunner.cancelAll()` |
| `compute` | Every compute lease that is provisioning or running (Atlas Nodes and rented GPUs) is ended: its instance terminated and its cost settled, reason `emergency_stop`. | `ComputeManager.terminateAll()` |
| `nodes` | Every Atlas Node job still queued or claimed is cancelled; a node holding one loses its claim. | `NodeService.terminate()` |
| `terminal` | Every terminal command an agent started is killed (whole process group). | `registerTerminalTools(...).cancelRunning()` |
| `approvals` | Every pending approval in the local inbox (`/v1/approvals`) is denied, with the same consequences as the owner denying it (legacy task failed, waiting session told no, Genesis publish and lane apply notified). The reason is written to the audit entry. | `LocalTaskStore.decideApproval(…, { reason })` |

## Guarantees

- **Isolation.** Each service is stopped in its own `try`. One that throws is
  reported as `failed` with its error, and the others still stop.
- **Idempotent.** Pressing stop again stops nothing new (every service reports
  `idle`). Two presses at the same moment share one stop.
- **Audited.** The route writes `platform.emergency_stop`; the hook writes
  `emergency_stop.services` with each service's outcome; each denied approval
  writes `approval.decided` with the stop's reason.
- **Summary.** The response's `hook` field is
  `{ stoppedAt, reason, ok, stopped, failed, services }`, where each service is
  `{ status, stopped: [ids], failed: [{ id?, error }] }` and `status` is one of
  `stopped`, `partial`, `failed`, `idle` or `not_running`. The command center
  shows this table under the header after the stop.

## Undoing a stop

Nothing is deleted. Resume each automation, mission, session or Genesis project
from its own page; resuming an automation re-arms the schedule timer. Denied
approvals stay denied, so the agent asks again when its work is resumed.

## Worker report

`GET /v1/platform/workers` now reports the daemon's real terminal controller
(the same instance the agents' terminal tools use, built on first use) and the
real MCP gateway. When no MCP servers are configured, or they are still
connecting or failed, it says so instead of "not running in this process".

## What it does not stop

- Legacy `/v1/tasks` coder runs that are already running have no cancel API;
  their pending approvals are denied, which fails queued ones.
- A Genesis stage that is mid-step (a coder call or a check) finishes that step
  before the pause takes effect; its next transition is refused.
- Genesis previews (dev servers) keep running; they are not work in flight.
- Goals keep their own timer and may wake on new events after a stop.

## Tests

- `apps/local-control/tests/emergency-stop-daemon.test.mjs` starts the real
  daemon (`main.mjs`, temporary SQLite data directory, scripted model, real MCP
  server), puts a team mission waiting on an inbox approval and a folder
  automation in flight, presses stop over HTTP, and checks through each
  service's own API that the mission is cancelled, the approval denied and the
  automation paused with its watcher closed. It also checks the worker report.
  Removing `onEmergencyStop` from `main.mjs` makes it fail.
- `apps/local-control/tests/emergency-stop.test.mjs` covers failure isolation,
  idempotence, concurrent presses, `MissionService.cancelAll` and
  `AutomationService.halt`/resume.
