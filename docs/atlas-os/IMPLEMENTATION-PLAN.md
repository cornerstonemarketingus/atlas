# Atlas — implementation plan

Ordered by the mission's strategy (§27): restore → canonical runtime →
spectacular Create slice → autonomous repository development → computer
operation → durable automation. Each step is a vertical slice that is only
"done" when it is reachable from the running daemon or web app, tested, and
observable.

## 0. Done on this branch

- Audit: `CURRENT-STATE.md`, `RECOVERY.md`, `GAP-ANALYSIS.md`, this plan.
- Security: SEC-5 (atomic hosted approval consume), SEC-6 (constant-time
  operator token), SEC-14 (workflow permissions, enforced by the checker).
- Agent company (§8): default families restructured — Business Development
  Executive → Product Executive → Market Research, Competitive Intelligence,
  Marketing, Sales, Analytics, Customer Success, Finance; Engineering (now with
  Architecture), a new Design parent, Computer Operations and Research are
  peer organizations the executives commission through scoped cross-family
  requests.
- Closed product-development loop: `platform/innovation/*` — Opportunity
  Briefs with evidence rules, Opportunity Memory with duplicate refusal,
  independent research, Implementation Proposals, review councils that keep
  dissent, digest-bound human approval (also in the approvals inbox),
  commissioning into the canonical platform task + peer delegation, bounded
  repair, human launch, measurement against the brief's own metrics, lessons.
  Wired into the daemon (`/innovation`, `/v1/innovation/*`). See
  `INNOVATION.md`.

- Chat: intent classification instead of keyword dispatch, streaming replies,
  safe Markdown, confirm-to-start task cards (project or computer).
- Computer control: desktop drivers (Windows UI Automation, X11), one
  planner across browser and desktop, deterministic desktop risk rules,
  daemon `desktop.*` tools, companion progress reporting to Operate.
- UI and copy: "Build it. Run it. Grow it." positioning with honest
  availability per mode; rail names Chat / Create / Operate.
- Foundations: outbox dispatcher + live dashboard stream, model routing with
  fallback for conversation turns, `terminal.run` over the platform
  TerminalController, and a coder-objective guard at hosted intake.

## 1. Canonical runtime (next)

1.1 **Agent step execution.** Bind a family agent to a model session: an
    `AgentWorker` that claims assignments (`TaskDelegation` state `assigned`),
    runs them through `AuthorizedToolExecutor` with the agent's own
    permissions as the policy subject, and submits results. First consumers:
    the BDE (draft briefs from signals) and the Research agents (validate).
1.2 ~~Outbox dispatcher~~ — done; next subscriber: agent workers.
1.3 **One policy path.** The live `ToolRegistry` now uses
  `PolicyEngine` through `platform/legacy-policy-bridge.mjs`; existing
  operator allow/ask/deny preferences and digest-bound approvals are
  preserved. Remaining: move handlers and all conversation/team execution
  through `AuthorizedToolExecutor` so durable budget, idempotency, approval,
  and event records share one dispatcher.
1.4 ~~Model router for conversation turns~~ — done; extend to coding and
    vision tasks and persist the model on each platform tool call.

## 2. Autonomous repository development (dogfood on Atlas)

2.1 Commissioned Engineering subtasks run the existing verified coder loop in
    an isolated worktree (`lc/runner.mjs`) and submit the verdict + patch as
    verification evidence; only a `passed` verdict can move an opportunity to
    `READY_TO_LAUNCH`.
2.2 Evidence sources for Atlas itself: CI failure history, failed Atlas Coder
    runs, `docs/atlas-os/BACKLOG.md` rows, security-review gaps — since the
    repository has no inline TODO markers.
2.3 ~~Hosted intake guard~~ — done (chat intent + coder-objective check).

## 3. Create — first spectacular slice

Prompt → Project Genesis artifacts (versioned, editable; same validation and
event model as Decision Packets) → plan → full-stack app in a worktree → live
preview via `apps/browser-worker` → Visual QA agent screenshot/critique/repair
→ DB/auth via a first provisioning adapter → browser E2E → preview deploy.

## 4. Operate and Automate

Terminal and desktop control are wired (see §0). Next: a hosted
browser/desktop worker for people without a paired PC, macOS desktop driver,
and a durable scheduler (local first; hosted needs Cron Triggers or Queues on
the Worker) that turns a successful task into a saved automation.

## 5. Security prerequisites before widening access

SEC-1 tenant model and SEC-2 revocable sessions before any multi-tenant
expansion of coder or computer capabilities; SEC-3 URL policy in daemon
browser tools.
