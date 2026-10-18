# Durable hosted task dispatch

Atlas's hosted task route previously dispatched the cloud workflow before saving
its task history. Storage failure could leave an active run invisible, and a lost
executor acknowledgement could incorrectly suggest that no work had started.

The existing native coding workflow, authenticated task API, D1 task/history
tables, GitHub integration, tenant scopes, billing gate and mobile activity view
are reused. No external agent framework or second execution router is added.

## Runtime behavior

`POST /api/tasks` retains the existing authentication, repository authorization,
tenant policy and plan checks. It atomically saves the conversation, task, user
request and audit event, then atomically records dispatch intent before making
one bounded external request. Failed prerequisite writes prevent dispatch.

The durable states are `recorded`, `dispatching`, `dispatched`, `unknown` and
`rejected`; preexisting tasks remain `legacy`. Transport failures and executor
server errors return an authenticated saved task identity with HTTP 202 and
`dispatch-unknown`. Explicit executor refusals retain the task and return HTTP
502. Provider response bodies and exception messages are not exposed.

`GET /api/tasks` reconciles managed tasks using one exact task title, repository,
trusted workflow, `workflow_dispatch` event and `main` control branch. Conflicting
matches are ignored. The run identity and stable reconciliation receipt are
saved together under the original tenant and principal. Reads never replay
dispatch. Legacy task matching remains unchanged. Activity shows saved pending
and uncertain requests, so users can reconnect and inspect progress.

## Deployment and security

Apply `apps/web/drizzle/0017_task_dispatch_intent.sql` using the existing D1
migration procedure before deploying the Worker. The task-storage readiness
check refuses new dispatches when the column is unavailable. This change does
not apply production migrations or deploy anything.

Intent writes cannot attach a task to another principal's conversation. Recovery
writes cannot change another tenant's task or replace an established run identity.
HTTP redirects are refused and external dispatch is bounded to ten seconds.
The acknowledgement deadline is enforced even when an injected transport ignores
its abort signal. An elapsed deadline leaves the saved task uncertain; no
automatic retry follows. A late response is discarded and its body cancelled,
without rewriting the uncertain receipt as success.
No additional secrets, permissions or execution environments are introduced.
Tenant-bound persistence requires owner review; this PR is not auto-merge eligible.

## Limits and follow-ups

This is durable dispatch accounting and read-only recovery, not a persistent job
queue. A process interrupted before the external request leaves an uncertain
intent and does not automatically retry. Custom executors have no GitHub run
reconciliation. A browser response lost after acceptance can still lead a user
to submit a new task: request-level idempotency keys are a separate next step.

The existing billing gate is unchanged; failed subsequent storage can consume a
plan reservation. Atomic billing is being developed separately in PR #203;
coordinate request idempotency and reservation settlement with that work rather
than introducing another accounting system. Pause/resume, worker leases, durable
queues and artifact retention remain future slices. Live production dispatch,
migrations and physical mobile-device behavior must be verified after authorized
deployment.

## Validation

The tests exercise real migrated SQLite transactions, rollback, tenant/principal
guards, missing migrations, uncertain acknowledgements, exact run matching and
the built Worker's HTTP task boundary with a fault-injected GitHub transport.
The external GitHub service is simulated; these tests do not prove deployment.

Local validation passed: all 472 web tests, production build, TypeScript check,
ESLint and `git diff --check`. Removing the conversation principal guard caused
its negative test to fail; restoring the guard made the test pass again.

2026-10-17 current-main integration: merged main 9443843 into the existing
branch, retaining Genesis task routing and current chat privacy behavior.
The cancellation-ignoring fixture exposed an indefinitely pending dispatch;
the enforced deadline and late-response regressions now pass. Rebuilt Worker
and full web suite: 507 total, 505 passed, two optional skips, zero failures.
TypeScript check and whitespace check passed. Fresh PR CI remains required.
No production migration, dispatch, publishing or credential change performed.
