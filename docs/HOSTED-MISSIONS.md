# Hosted mission recovery

The `/missions` screen saves an explicit plan of one to eight existing-repository tasks. Saving does not execute it. Start/reconcile uses the existing authenticated `/api/tasks` intake, so repository permissions, task allowances and execution policy remain enforced there. Each step has one durable dispatch intent; uncertain acceptance is reconciled by its scoped correlation and exact task specification, never blindly resubmitted.

Mission records belong to both the authenticated tenant and principal. Concurrent updates use a revision compare-and-swap in the same D1 transaction as an append-only audit event. A paused or stopped mission can still collect an already-started task's receipt but cannot start another task. Stop does not cancel an external Actions run.

Completion requires the exact persisted GitHub run, a matching task name, a successful completed current attempt, and the stored runner result with the same run/attempt identifier. An older attempt's result cannot release dependent work. Verified failed GitHub runs stop further dispatch. All tasks run sequentially on their specified branch; predecessor code changes are not automatically merged into later tasks.

## Deployment and review

This adds tenant persistence and needs the configured owner review. Apply `apps/web/drizzle/0021_cloud_missions.sql` to the target D1 database before enabling the route. It is deliberately additive and idempotent. Its number avoids the pending task-intake migrations 0017-0019 and execution-outcomes migration 0020 in PR #289. The shared Drizzle journal/schema are owned by those pending PRs; integrate this migration into the journal in merge order during that review. It is not applied to production by this change. A missing table yields an actionable unavailable response.

## Evidence and limits

Nineteen service/HTTP/production-adapter tests and three request deadline tests cover isolation, idempotency, concurrent resume, restart, lost acknowledgements, audit rollback, pause during dispatch, stopped reconciliation, stale workflow-attempt results, pagination, managed-runner preflight and durable dispatch state transitions. The real Chromium desktop/mobile gate exercises the screen against the actual HTTP handler and SQLite-backed D1 adapter, including older history, reload and no duplicate dispatch. External execution is stubbed in that browser fixture. Complete cross-platform CI passed on commit `609f1308be9d34893182f39c370b0343032c0750` (Actions run `38992055213`); this includes the production web build and test suite. This is branch evidence, not a production mission acceptance result.

The page polls only while open and signed in. A started Actions task can finish after closing the page, but subsequent steps require reopening/reconciling. This is durable recovery, not unattended scheduling. No browser credential is stored. Remaining work includes scoped unattended execution grants and scheduler ownership, cumulative monetary budgets, integrated hosting/CRM/business operations and live deployment acceptance. Durable task intake (#270/#274) and callback fencing (#278/#282) remain separate owner-reviewed prerequisites for stronger recovery guarantees.

Mission history is paged in bounded groups of 30 summaries with an opaque cursor ordered by update time and ID. Load older missions reaches prior records without dispatching work. The HTTP cursor is validated and every page is independently scoped to the authenticated tenant/principal. The 65-record fixture and real desktop/mobile older-history journey pass; changing records between page loads follows normal live-history ordering rather than a frozen snapshot.

Mission execution currently supports the managed GitHub Actions runner. A configured private dispatcher remains available through its existing task entry point, but missions reject starting it because no compatible mission outcome evidence is wired. Accepted work whose durable receipt is unconfirmed remains uncertain with its known task ID, and later reconciliation cannot promote a private-runner row into managed verification. No automatic retry is sent.

The adapter is compatible with the pending durable-dispatch contract in #270 without requiring its new column on current main. A saved unknown intent is insufficient to confirm acceptance. Existing task progress reconciliation or a verified result callback must supply run identity/acceptance; a persisted rejection fails the mission's dependent work. The mission does not duplicate the task API's GitHub matching or issue another dispatch. These transitions are tested against the real mission runtime and SQLite fixture; the owner-reviewed #270 migration/deployment remains a separate prerequisite.

## Release acceptance checklist

1. Resolve the configured persistence review and integrate the shared migration journal with the active task persistence owners. Preserve migration order and inspect the target schema before applying anything.
2. Use the existing Apply Atlas D1 migrations workflow with `from_migration=0021`, `through_migration=0021` and `dry_run=true` against the intended database after the reviewed migration is available on the release ref. Confirm the output selects only `0021_cloud_missions.sql`. Apply that exact bounded range only after the reviewed rollout is ready. Deployment does not apply migrations automatically.
3. Deploy the reviewed application revision. Confirm the deployment run SHA: the latest verified hosted release remains `dee7942d7fb4a3971229be1f2ca9d97e8cef3eaf` (deploy `38834441273`), which predates missions. A green branch preview or main CI is insufficient.
4. With a configured authenticated account, save a mission, reload it, start one authorized managed task and reconcile its exact run and current-attempt result. Verify pause/stop prevents future dispatch and a second principal cannot read the first mission. Capture task/run/receipt IDs without credentials.
5. Report unattended advancement as incomplete until a separately reviewed scheduler and scoped execution grants pass closed-page live acceptance. CRM account configuration and real website inquiry delivery also need separate live acceptance; merged local tools alone do not establish those outcomes.

## Maintenance integration — 2026-10-21

Mission request bodies have a 15-second server deadline as well as the 64 KB
size limit. Incomplete uploads return 408; oversized uploads return 413 even
if stream cancellation stalls. Neither rejection creates or dispatches work.

Current-main migration fixtures already contain dispatch_state. The durable-dispatch adapter tests now assert that migrated schema instead of applying a duplicate ALTER TABLE; their ownership, no-redispatch and outcome assertions are unchanged. Internal storage failures use fixed customer copy without migration instructions. All 20 cloud-mission tests pass locally, including real runtime adapter boundaries. Fresh complete CI remains required; no migration or production execution was performed by this integration.
