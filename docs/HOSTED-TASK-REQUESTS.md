# Safe hosted task requests

This slice builds on PR #270's durable dispatch. The normal task route, tenant
model, repository permissions, plan gate, cloud executor and task history remain
the execution path. `POST /api/tasks/requests` reserves one authenticated request
before calling that route; it is not another agent loop or billing implementation.

## Client contract

Send the normal task JSON body and a UUID v4 `Idempotency-Key` header. Reuse the
same key and identical JSON content after a lost response. Property order does
not matter; changed content returns HTTP 409 without exposing the earlier task.
Keys are scoped to both tenant and principal. A key is not an authorization token.

The first call durably reserves admission before execution or billing. Concurrent
calls and later retries never enter the task route again. A completed response
is replayed with `replayed: true`. An unfinished reservation returns HTTP 202 with
`requestState: pending`; a scoped task found through its server-generated
correlation ID is returned without redispatch. Age alone never permits takeover.
Even a crash before execution leaves a reservation for manual investigation.

All outcomes are private and uncached. Authentication and current workspace
membership are checked for each request, including replays. New execution still
passes through the existing repository access, tenant policy and plan checks.
Requests are bounded to 64 KiB, nesting to 20 levels, and response receipts to
16 KiB. Missing request storage fails before the existing task route is called.

## Build view

The existing Build view uses this endpoint and saves a payload digest and opaque
request key before sending. It retains them on network failure or an uncertain
receipt, and releases the key after acknowledging a completed response. Storage
failure prevents sending; corrupt or full unresolved-key storage is not silently
discarded. No task objective, repository text, session or credential is saved in
this retry cache. Up to 256 unresolved request keys can be retained.

After response loss, send the same request to check its outcome. Existing task
history can also be opened after reconnect. This cache does not persist composer
drafts: reproducing the same payload after a full reload may require re-entering
the objective. Simultaneous submissions from separate tabs and account-switching
client workflows have not been verified. The server isolates their owners but
does not deduplicate different keys.

## Deployment and dependencies

This branch is stacked on `codex/durable-dispatch` / PR #270; review this slice
against that branch. Apply migrations 0017 and 0018 before deploying it. There
is no production migration, merge or deployment performed by this implementation.

PR #272 owns the normal task route and chat submission. Those files are untouched;
chat can adopt this endpoint in a coordinated follow-up. Direct `/api/tasks`
callers retain their existing behavior and do not gain request deduplication.
PR #203 owns atomic billing caps. Its implementation and tests are untouched.
Same-key replays do not re-enter billing, but different-key concurrency and usage
refunds/settlement remain billing work. A failed dispatch can still consume usage.

## Operational limits

Reservations and receipts remain durable indefinitely. They are not automatically
expired, retried or deleted, because doing so could duplicate work. Operators need
a later authenticated investigation/settlement flow for abandoned reservations.
Storage growth, per-tenant request rate governance, retention policy and request
status lookup without resubmitting the body are follow-ups. There is no lease
takeover, persistent queue, automatic worker replacement or new sandbox here.

The tests use real migrated SQLite, concurrent admissions, failure injection and
the built Worker HTTP boundary. External GitHub transport is simulated; production
and physical mobile devices require verification after authorized deployment.
Tenant-scoped admission requires owner review, so auto-merge is not eligible.

Local validation passed: production build, TypeScript, ESLint, all 482 web tests
and diff checks. Removing the recovery principal guard failed its negative test;
the restored guard passed again. The shared progress log is owned by active PRs;
this document and issue #273 provide the implementation handoff.
