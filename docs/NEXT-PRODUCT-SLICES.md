# Next Atlas product slices

Requested priorities, audited against main `a1ec6ab` on 2026-09-28. These are
acceptance criteria for upcoming work, not claims of shipped features.

Follow-up audit at `f7d7dbf`: Command Center, parallel launches, approved
patch application and local cron/webhook automations have landed (#167–169).
The Genesis runtime branch adds the first database/jobs slice described below.
The original acceptance criteria remain here to track the broader gaps.

## 1. Parallel agents and Agent Command Center

Extend `apps/local-control/src/agent/mission-scheduler.mjs`,
`agent/team/team-service.mjs`, and the existing mission UI in `src/ui.mjs`.
They already provide concurrent dependency scheduling, leases, persistence,
team delegation and mission controls. Do not add a second scheduler.

First slice: an authenticated live mission view of the actual child tasks,
assigned agents, dependencies, current activity, queue/blocked reason,
token usage, findings and artifacts. Show unavailable cost explicitly rather
than inventing estimates. Resume from persisted mission state on reconnect.
Prove two independent steps overlap and a dependent reviewer starts only
after their artifacts exist. Pause/cancel must act on the existing runtime.

Before enabling concurrent repository mutations, reconcile isolated execution
PR #106 with the existing isolated coder path. Require separate working copies,
base revision evidence, validated integration and visible merge conflicts.
Audit the swallowed `family.markRunning` exception in `agent/team/step-executor.mjs`:
the family view must accurately describe scheduled work and capacity waits.

## 2. Automate this

The hosted `app/automation/AutomationSection.tsx` currently presents supervised
computer tasks. Open PR #78 owns scheduled/event automation work; reconcile it
before introducing another automation store or dispatcher.

First slice: a completed task can produce an editable, inactive automation
draft containing the objective, tool requirements, permissions, trigger,
budget and notification conditions. Activation requires the user's approval.
Execute through the normal task runtime; retain links from definition to runs
and from runs to evidence. Verify cron and signed webhook delivery, duplicate
events, bounded retries, dependency waits, restart recovery, pause and history.
Retries must not duplicate external side effects. Never copy task secrets into
the definition. Notifications should be conditional, not emitted on every poll.

## 3. Genesis Atlas Runtime

Genesis already executes templates, validates and repairs projects, previews
them and supports publishing. Its generated web/API templates include SQLite
storage; this is a starting point, not a complete shared backend platform.

First slice: versioned `atlas.database` and `atlas.jobs` contracts with local
adapters consumed by one generated CRUD app and one durable background job.
Verify migrations, restart persistence, bounded retries and data isolation.
Then add `atlas.auth`, `atlas.storage`, `atlas.secrets`, `atlas.email`,
`atlas.realtime`, `atlas.payments` and `atlas.analytics` through configured
adapters with policy and approval checks at their real execution boundaries.
Do not label a primitive available until a generated application uses it and
its lifecycle, error handling and isolation are tested.

## Reliability prerequisites and coordination

Keep the existing reset-header parsing, explicit fallback controls, endpoint
security and tool-result compaction. Inference PRs #129–133, #158 and #160 own
the governor and model pool; route the product slices through those interfaces
once integrated. Preserve logical agent parallelism while capacity admission
queues physical model calls. Never turn capacity waits into lost task state.

This change fixes web typechecking, Windows workflow-test paths/line endings,
and Genesis's assumption that Node always defaults to TAP test output.
The original build-fix PR did not implement these product slices. The runtime
follow-up now wires `createAtlas` into generated web/API servers and ships a
durable daily summary job through `npm run jobs`, including built output.
Runtime v1 reuses validated SQLite records; jobs add restart persistence,
deduplication, bounded retries and leased/fenced execution. Each application
owns separate database files. This is not hosted tenancy or authentication.
Remaining: job cancellation/lease renewal, richer worker scheduling, schema
evolution, and the auth/storage/secrets/email/realtime/payments/analytics adapters.
