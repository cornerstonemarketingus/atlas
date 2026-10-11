# Hosted request inspection

This slice builds on PR #274's request reservations and PR #270's durable task
intent. Their existing D1 records, authentication, workspace resolution and task
correlation are reused. No new queue, executor, model router or migration is added.

## Runtime and mobile access

`GET /api/tasks/requests` lists the authenticated principal's requests in the
selected workspace. Pages contain at most 20 requests, ordered by creation time
and request key. The `nextCursor` supports bounded keyset pagination. Each request
loads at most two correlated task records; two matches make the result ambiguous.
Task objective previews are limited to 240 characters.

`GET /api/tasks/requests/:requestKey` inspects one UUID request without needing the
original request payload or browser retry cache. Missing and foreign records both
return the same 404. List/detail responses are uncached and repeat authentication
and workspace membership checks. Invalid cursors return 400; unavailable storage
returns 503 rather than an empty successful history.

The existing Build view contains a collapsible **Saved requests** panel. Users can
refresh, page through history, check an individual request and open a recovered
task's activity. Opening it starts bounded polling; closing it stops polling and
aborts the page read. Hidden tabs skip polls. Buttons have mobile-sized touch
targets and the content scrolls within a bounded panel.

## Evidence and recovery boundaries

- `task-saved`: one exact task matches the request's server-generated correlation
  ID, tenant and principal. Its dispatch state is shown as an observation. Accepted
  dispatch does not prove execution, tests or completion; activity supplies that.
- `refused`: the saved receipt records an explicit client refusal or dispatch
  rejection. Checking it starts no retry.
- `acknowledged`: a successful request receipt exists but task history is absent.
  This does not assert that a cloud task is running or complete.
- `unconfirmed`: no trustworthy final outcome or matching task is available. It
  may still be processing; elapsed time alone never proves abandonment.
- `ambiguous`: multiple scoped tasks match. The API suppresses task details and
  requires investigation rather than choosing a task.

Raw receipt JSON, provider messages, fingerprints and privileged links are not
returned by inspection. Foreign tasks cannot be recovered even when they spoof
the same correlation ID. Existing uncertain POST recovery now shares the same
bounded, scoped task lookup instead of maintaining a second implementation.

Inspection does not call a model, GitHub executor or billing admission. It does
not modify request reservations, task state or usage, release keys, expire claims,
retry dispatch or decide refunds. Existing identity/workspace infrastructure may
bootstrap a signed-in account's membership on its first visit, as before.

## Validation and deployment

Tests cover real migrated SQLite, both ownership boundaries, bounded pagination,
correlation spoofing, ambiguous records, damaged receipts and safe status labels.
The built Worker's HTTP boundary verifies reconnect, list/detail access, refusal
of foreign records, invalid inputs, unavailable storage and zero external calls.
Request/task/usage snapshots must remain unchanged across inspection.

Local validation passed: production build, TypeScript, ESLint, all 490 web tests
and diff checks. Tenant, principal and correlated-task guard mutations failed
their negative tests; restored guards passed. Detail-resource retry POST is refused.

This branch is stacked on `codex/task-request-idempotency` / PR #274. Its prior
migrations 0017 and 0018 must be applied before deployment. No production migration,
merge or deployment is performed here. Physical mobile-device behavior and live
production reads require verification after owner-approved deployment.

## Remaining work

This is authenticated investigation and discovery, not a reservation-release or
automatic recovery mechanism. Abandoned admissions require a separately reviewed
resolution policy with proof of no external execution and coordinated billing
settlement. Chat adoption remains separate. Retention, per-tenant rate governance,
worker leases and durable queues remain future slices. Tenant-scoped access
requires owner review; auto-merge is disabled for this workstream.

The shared progress log is owned by active PRs. This document and issue #275
provide the implementation handoff without overwriting their work.
