# Provider cooldown and scoped observer health

Issue #345; builds on bounded observation #335. Audit: 2026-10-17.

Atlas already had scoped opt-in, immutable reservation budgets, a native scheduled
Worker and verified GitHub execution receipts. Automatic observation lacked a
durable provider pause and the Saved requests view could not explain deferred
checks. Existing dispatch, inference and active cloud-mission implementations are
reused without introducing a second scheduler or agent runtime.

## Runtime behavior

The scheduled observer reuses the native GitHub header parser. It honors the
longest valid Retry-After/reset deadline, with exponential fallback for repeated
rate limits. Authentication/permission failures pause for an hour, transient
failures for fifteen minutes, and a missing run backs off only its watch. This
follows [GitHub's rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately).

D1 stores one shared GitHub Actions observer pause. Atomic updates cannot shorten
an existing deadline. Both candidate selection and reservation consult it; every
HTTP request checks it again, including installation-token requests. A response
that exhausts quota can finish being consumed, but the next metadata request is
deferred. A refusal stops the current tick. Already in-flight requests may finish.
Completed verification resets the failure streak only after the pause expires.

Reservations remain charged on failure, interruption or storage uncertainty.
Existing consent expiry, membership checks, per-task/tenant/global budgets and
execution deadlines remain in force. No retry launches coding or releases claims.
Cooldown persistence cannot be atomic with a remote HTTP response; a crash before
persisting that response can lose its hint. Storage failure still stops this tick.

Saved requests projects health through the existing authenticated tenant/principal
query. It distinguishes stopped/expired/exhausted checks, provider pauses, budget
waits, per-watch backoff and an unfinished reservation. The next eligible time is
an earliest bound, not a scheduling promise. A twenty-row page shares provider and
budget reads (23 prepared queries total). No other task identifiers or aggregate
quota counts enter the response. UI explanations use a closed vocabulary.

## Security and rollout

Only sanitized numeric deadlines and fixed categories are persisted. Provider
bodies, raw headers, credential values and private URLs are not health data. This
policy governs automatic observation only; manual reconciliation and other GitHub
clients retain their existing policies. Shared credentials make a shared observer
pause appropriate; future per-installation credentials will need separate keys.

Apply migration `0023_observer_health.sql` after `0022_task_outcome_observation.sql`
before deploying the Worker. Migration 0021 belongs to the separate cloud-mission
work; reconcile the journal in merge order. Missing schema fails closed. No new
credentials, cron schedule or infrastructure are required. Owner review of the
protected Worker changes remains required. No production migration, deployment,
live provider quota exercise or physical-phone verification is claimed.

## Validation

The production build, type check and all 539 web tests passed, including the
authenticated built Worker boundary with real SQLite and mocked GitHub HTTP.
Five deliberately weakened guards failed assertions: provider eligibility,
monotonic deadlines, HTTP preflight, principal scoping and shared history reads.
Source was restored before the full suite. These tests do not exercise a live
GitHub quota or Cloudflare cron delivery.

Shared PROGRESS/roadmap files have concurrent ownership, so this focused document
and the issue handoff record the slice without overwriting those edits. No TODO
file was created. Next: integrate and validate the stacked cloud execution and
observer changes in an authorized staging environment before expanding autonomy.
