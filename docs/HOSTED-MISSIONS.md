# Hosted mission recovery

The `/missions` screen saves an explicit plan of one to eight existing-repository tasks. Saving does not execute it. Start/reconcile uses the existing authenticated `/api/tasks` intake, so repository permissions, task allowances and execution policy remain enforced there. Each step has one durable dispatch intent; uncertain acceptance is reconciled by its scoped correlation and exact task specification, never blindly resubmitted.

Mission records belong to both the authenticated tenant and principal. Concurrent updates use a revision compare-and-swap in the same D1 transaction as an append-only audit event. A paused or stopped mission can still collect an already-started task's receipt but cannot start another task. Stop does not cancel an external Actions run.

Completion requires the exact persisted GitHub run, a matching task name, a successful completed current attempt, and the stored runner result with the same run/attempt identifier. An older attempt's result cannot release dependent work. Verified failed GitHub runs stop further dispatch. All tasks run sequentially on their specified branch; predecessor code changes are not automatically merged into later tasks.

## Deployment and review

This adds tenant persistence and needs the configured owner review. Apply `apps/web/drizzle/0021_cloud_missions.sql` to the target D1 database before enabling the route. It is deliberately additive and idempotent. Its number avoids the pending task-intake migrations 0017-0019 and execution-outcomes migration 0020 in PR #289. The shared Drizzle journal/schema are owned by those pending PRs; integrate this migration into the journal in merge order during that review. It is not applied to production by this change. A missing table yields an actionable unavailable response.

## Evidence and limits

Eleven service/HTTP/production-adapter tests cover tenant and principal isolation, idempotency, concurrent resume, restart, lost acknowledgements, audit rollback, pause during dispatch, stopped reconciliation, and stale workflow-attempt results. The real Chromium desktop/mobile gate exercises the screen against the actual HTTP handler and SQLite-backed D1 adapter, including reload and no duplicate dispatch. External execution is stubbed in that browser fixture. Production build, typecheck, lint and the full web suite pass (494 passed, two optional browser gates skipped); the mission browser gate additionally passed explicitly.

The page polls only while open and signed in. A started Actions task can finish after closing the page, but subsequent steps require reopening/reconciling. This is durable recovery, not unattended scheduling. No browser credential is stored. Remaining work includes scoped unattended execution grants and scheduler ownership, cumulative monetary budgets, integrated hosting/CRM/business operations and live deployment acceptance. Durable task intake (#270/#274) and callback fencing (#278/#282) remain separate owner-reviewed prerequisites for stronger recovery guarantees.
