# Hosted task cancellation

Atlas's existing managed tasks run independently of the user's computer in
GitHub Actions. This increment adds a Cancel run button to the existing task
activity card, including the mobile web layout, and the authenticated endpoint
`POST /api/tasks/:taskId/cancel`. It extends existing task control rather than
adding a scheduler or agent runtime. Workstream: #260, part of #41.

## Repository findings and reuse

Main already has authenticated task dispatch, tenant-scoped D1 task and
conversation history, exact task IDs in workflow run titles, live activity,
native coding, PR creation, and replay-safe result callbacks. PR #253 adds
container-isolated hosted validation and remains a separate review. Main lacked
hosted cancellation: local operator cancellation in PR #237 cannot stop a
hosted run. Dispatch durability remains unfinished; PR #191 owns the dispatch
route, so this change leaves that workstream to its owner.

This endpoint reuses `authenticatedAccount`, session revocation,
`resolveTenantContext`, existing D1 migrations and `run_events`, GitHub App
Actions-write tokens, existing workflow selection and task/run identity
contracts. It introduces no credentials, migrations, background processes,
external coding framework, or inference router.

## Runtime and authorization

The existing `TaskActivity` client calls the endpoint using same-origin
credentials, displays the result and continues its normal progress polling.
The Worker requires authentication and both the task's tenant and requesting
principal. Cross-origin browser writes are refused. Custom/private executors
are explicitly unsupported.

The server independently reads GitHub's run before cancellation. It verifies
repository, task UUID in `display_title`, workflow, trusted `main` branch,
`workflow_dispatch` event, run ID and positive attempt. A historical time-based
run assignment cannot authorize cancellation. If no run ID is saved, one
bounded listing may discover a unique exact match; missing or ambiguous
matches are refused. Requests cannot supply a repository, credential or run ID.
The existing activity identity helper and task-list normalization now read `display_title` before `name`:
GitHub's real API separates a workflow label from its custom run title.

Before the external POST, D1 saves an intent through a tenant/principal-scoped
task/conversation join. Stable receipt IDs include task, run and attempt.
Storage failure prevents the action. A confirmed acceptance is saved separately;
subsequent requests for that attempt return the saved acceptance. After an
uncertain response, repeating ordinary cancellation is safe; repository work
is never replayed. Re-instantiating the handler preserves this behavior because
receipts live in D1, not process memory.

Provider calls have eight-second timeouts and refuse redirects. Responses and
logs contain no provider body, credential, task objective or privileged link.
GitHub's documented cancellation response is **202 Accepted**, not proof that
execution stopped ([GitHub API contract](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run)).
The client distinguishes requested, unconfirmed and completed states. Existing
live activity remains the authority for the final status.

## Validation and limits

Database tests apply all real migrations, use Atlas's authentication and tenant
resolution, check durable receipts and ordering, and exercise the built Worker
HTTP route. Negative cases cover unauthorized and cross-tenant/principal
access, cross-origin requests, mismatched run identities, ambiguous discovery,
private executors, unavailable credentials/audit storage, lost acknowledgements,
provider refusal and completion races. The ownership guard is mutation-checked.

Executed on 2026-10-10: existing task-result/storage baseline 10/10; final
web suite 472/472 (11 cancellation tests, including the built HTTP route and
live cancelled-status confirmation); web lint, typecheck, production build,
and `git diff --check` passed. Removing the principal guard caused the negative
test to fail; it was restored afterward. GitHub calls in integration tests are
controlled responses, while the Worker routing and migrated database are real.
Concurrent dispatches with reversed creation order are regression-tested
through the actual GitHub normalization and exact task/run matcher.

This does not implement a durable dispatch outbox, worker leases/replacement,
pause/resume, or orphan sandbox reconciliation. A run not yet visible to GitHub
cannot be cancelled through this endpoint until it becomes identifiable. Only
the latest 100 workflow dispatches are considered for discovery. GitHub's
ordinary cancellation may let cleanup/reporting jobs continue; no force-cancel
is issued. It does not undo edits, commits or pull requests already created.
There is a narrow GitHub rerun race because the cancellation API addresses a
run ID rather than a specific attempt. No production deployment, live task
cancellation, or physical-phone interaction has been verified by these tests.

Next eligible implementation: durable pre-dispatch task intent and idempotent
dispatch reconciliation, coordinated with the owner of PR #191, followed by
worker leases and orphan sandbox cleanup. Protected authorization/control
changes require owner review; do not auto-merge this PR.
