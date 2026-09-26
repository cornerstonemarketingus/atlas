# Atlas OS: implementation checklist with evidence

Branch `claude/atlas-platform-development-o9znpd` (PR #59). Updated 2026-09-26.

Each row is marked by what was actually shown:

- **Verified e2e**: exercised against a running process. The main evidence is
  `npm run e2e` in `apps/local-control` (`scripts/e2e/journey.mjs`), which runs
  in CI and prints one PASS/FAIL line per step.
- **Tested**: unit or integration tests over the real modules.
- **Owner action**: blocked on something only the owner can do.

The e2e journey uses a scripted model. It proves the runtime around the model
(scheduling, delegation, policy, approvals, recovery, persistence), not model
quality.

## Phase 0: audit and recovery

| Item | Status | Evidence |
|---|---|---|
| Hosted chat answers in production | Verified in production | Verify workflow run 36201960356 (RECOVERY.md §1) |
| Hosted task creation | **Owner action**: returns 502 in production | Verify run 36203794563. Most likely an invalid or under-scoped `ATLAS_GITHUB_TOKEN`. Every failure now carries an explanation (`tasks/github-diagnosis.mjs`), and `/api/setup/status` probes the credential read-only. See RECOVERY.md §1b |
| Local: create a task, track status, get model responses, one safe execution | Verified e2e | journey steps 1–4 |
| Current state, recovery, gap analysis, plan | Done | `CURRENT-STATE.md`, `RECOVERY.md`, `GAP-ANALYSIS.md`, `IMPLEMENTATION-PLAN.md` |

## Phase 1: unified execution

| Item | Status | Evidence |
|---|---|---|
| One scheduler: agent missions run on the existing `MissionScheduler` (no second scheduler or state machine) | Verified e2e | `agent/team/team-service.mjs` composes `MissionService` + `PlatformTaskStore`; journey "mission completed and platform task completed" |
| One task lifecycle with transitions | Verified e2e | journey prints `authorized>queued>running>verifying>completed` |
| Outbox consumer | Tested | `platform/outbox-dispatcher.mjs` (commit 6e37451) |
| Leases, checkpoints, cancellation | Verified e2e | journey "pause…", "resume…", "cancel…" |
| Recovery after the worker dies | Verified e2e | journey kills the daemon (SIGKILL) mid-step. The mission comes back `interrupted`, the owner resumes it, and it completes |
| Correlation ids | Implemented (no dedicated e2e check) | platform task `correlationId` is carried into the root delegation (`team-service.mjs`) |
| Artifact verification | Verified e2e | journey "artifacts verified with evidence" |

## Phase 2: model-driven agents

| Item | Status | Evidence |
|---|---|---|
| goal → plan → tools → observe → verify → retry/replan | Verified e2e | `agent/team/planner.mjs`, `step-executor.mjs`; journey steps 3–8 |
| Plans only over agents that exist; no cycles | Tested | `team-missions.test.mjs` "plans are validated…" |
| Agents only get tools their permissions map to | Tested + e2e | `team/permissions.mjs`; test "an agent cannot use a tool outside its permissions" |
| Delegation: downward only, no recursion or cycles, cross-family scoped help without authority | Tested + e2e | `platform-family.test.mjs` (lines 61, 96, 111, 346); journey "delegation recorded on the family graph" |
| Depth, concurrency, per-parent and spend limits | Tested | `platform-family.test.mjs` "caps…", "budget limits…"; spend charged to the agent that worked (`finish()` → `chargeBudget`) |
| Memory with provenance, recall as data | Tested + e2e | `team-missions.test.mjs` "verified work is remembered…"; journey "verified work remembered with provenance" |
| Model routing with fallback | Tested | `agent/models/routed-client.mjs` (commit 6e37451) |
| Traces and token usage shown in the UI | Verified in browser | Missions view: tool-call table, hand-offs, usage |

## Phase 3: browser, desktop, terminal

| Item | Status | Evidence |
|---|---|---|
| Browser tools behind policy, SSRF guard on navigation and redirects | Tested | `tool-families.test.mjs` (SEC-3), `windows-companion/tests/url-safety.test.mjs` |
| Desktop control through the companion, fails closed without a desktop | Tested (Windows test in CI) | commit 54adf1a |
| Terminal: no shell, allow-listed commands, separate workspace, `ask` by default | Tested | commit 6e37451; default policy `terminal.run = ask` |
| Hosted browser refuses rather than queueing work nothing runs | Tested | SEC-10 (`computer/browser-plan.mjs`) |

## Phase 4: security

Status of every finding is in `SECURITY-REVIEW.md` §2. Summary:

| Finding | Status |
|---|---|
| SEC-2 revocation, SEC-3 SSRF, SEC-4 coder env, SEC-5 atomic approvals, SEC-7 auto-merge, SEC-8 vault, SEC-10, SEC-12, SEC-13, SEC-14 | Fixed, with tests |
| SEC-1 tenant model | Mitigated (per-user GitHub permission check). A full tenant model is still open |
| SEC-6 rate limiting on web routes | Open |
| SEC-9 hosted audit trail | Open |
| SEC-11 prompt-injection corpus | Partly addressed: untrusted content passed as `<data>`, MCP descriptions and outputs flagged. No fixture corpus yet |
| Approvals are single use and bound to the exact action | Verified e2e: journey "the approval was spent exactly once", "a denied action never runs" |
| Approval flow for agent steps | **Fixed in this pass.** The e2e run found that an approval could never be used, because the step had already failed. Steps now wait for the decision at a checkpoint, so pause and cancel still work (`team-missions.test.mjs`: 3 tests) |

## Phase 5: integrations

| Item | Status | Evidence |
|---|---|---|
| MCP gateway connected to real tool execution | Verified against a real stdio server | `platform/mcp/daemon-bridge.mjs`. New servers are denied until allowed. Flagged tools are blocked. Output is marked untrusted. `mcp-memory-runtime.test.mjs` |
| Scoped memory: provenance, retrieval, deletion | Tested + e2e | `/v1/knowledge` routes; deleting erases every version |
| Tool discovery for the owner | Done | `GET /v1/tools` (catalog + policy), Computer view |
| Skills | Not started | |

## Phase 6: UI

| Item | Status | Evidence |
|---|---|---|
| Local console: Home, Missions, Agent families, Computer, Projects, Knowledge, Connections, Approvals, Settings | Verified in browser (desktop and 390 px phone, dark and light) | commit 7edd053; `tests/local-control.test.mjs` asserts all nine sections |
| Hosted app uses the same names; local-only sections linked, not imitated | Verified in browser | commit 85a2c6b |
| Strict CSP kept (no inline script or style) | Tested | `local-control.test.mjs` |

## Phase 7: copy

- The console status line only says a model is available after finding one.
  Model discovery now includes the configured endpoint and routes.
- The Computer view describes each capability as it actually behaves. For
  example, sending messages is refused because no mail service is connected.
- The hosted browser is labelled "not available yet". It is not sold as
  running.

## Phase 8: end-to-end journey

`npm run e2e` in `apps/local-control` (also a CI step). Last local run: 21/21
PASS.

| Journey step | Result |
|---|---|
| Unauthenticated request refused | PASS |
| Model configured and discovered | PASS |
| Goal planned into steps over real agents | PASS |
| Mission and platform task completed | PASS |
| Delegation recorded on the family graph | PASS |
| Authorized tool ran and was traced | PASS |
| Artifacts verified with evidence | PASS |
| Output grounded in the tool result | PASS |
| Verified work remembered with provenance | PASS |
| Denied capability blocks the tool, mission fails honestly | PASS |
| Ask policy pauses the step for an approval of the exact action | PASS |
| Approved action runs and the mission completes | PASS |
| The approval is spent exactly once | PASS |
| A denied action never runs | PASS |
| Pause, resume, cancel | PASS |
| Daemon killed mid-step, mission visible afterwards, owner resumes, it completes | PASS |
| History after restarts | PASS |
| Audit log records policy changes and decisions | PASS |

Not covered by the journey: hosted sign-in with GitHub (needs production
credentials) and a real model's plan quality.

## Owner actions needed

Secret names only, no values.

1. **Fix hosted task creation.** Rotate `ATLAS_GITHUB_TOKEN` (repo and
   workflow scope on the target repository), or configure the GitHub App
   secrets `ATLAS_GITHUB_APP_ID` and `ATLAS_GITHUB_APP_PRIVATE_KEY`. Then
   redeploy and run the verify workflow. See RECOVERY.md §1b.
2. **Apply D1 migration `0014_session_revocation.sql`** with the manual
   `migrate-d1.yml` workflow. Until it is applied, revocation degrades to
   stateless sessions.
3. **Review and merge PR #59.** Nothing here was merged or deployed without
   you.

## Known limitations

- The shared task lifecycle has no `paused` state. While a mission waits for
  a resume, its platform task reads `running`. The console shows the mission's
  own `interrupted`/`paused` state instead. Adding the state is a contract
  change for a separate PR.
- A step waits at most 15 minutes for an approval, within its 20-minute step
  budget. After that the step fails with `APPROVAL_TIMEOUT`.
- Agent missions, agent families, knowledge and approvals run on the local
  daemon. The hosted app links to them rather than duplicating them.
