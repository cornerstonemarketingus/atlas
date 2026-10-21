# Saved claim reconciliation

Issue #302; stacked on outcome receipts #289. Audit date: 2026-10-16.

## Finding and integration

Native hosted workflows already claim execution and report authenticated outcomes.
Whole-workflow cancellation or infrastructure failure can prevent their reporting
job from running. An expired lease is not evidence that execution failed safely;
Atlas previously had no scoped way to observe an exact saved claim after that gap.

Saved requests now offers **Reconcile execution** when a claim has no outcome.
The action POSTs an empty JSON object to
`/api/tasks/requests/[requestKey]/reconcile`. Existing account authentication and
membership resolution determine tenant/principal scope. The server resolves the
request's unique task, matching conversation ownership and durable execution claim.
Foreign requests are indistinguishable from missing requests; ambiguous, unclaimed
or unsupported tasks are refused before external verification.

The server reads the exact saved GitHub run attempt, checks the immutable Atlas
repository ID, workflow path, main branch, task title, run and attempt, then reuses
the terminal execution-job verifier from #289. It never searches for a newer run
or uses age as evidence. Redirects are refused and each API request has a ten-second
timeout. There are at most two GitHub metadata reads, no model or execution calls.
GitHub endpoint references:
- https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt
- https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt

## Persistence, authorization and safety

The same D1 snapshot/tenant/principal/claim guards now support outcome-only writes:
the immutable receipt and stable outcome audit event commit in one batch with no
synthetic agent report or result message. A later authentic agent report can still
append its summary using the existing result ID. Conflicting observations and
ownership changes refuse writes; audit failure rolls back the receipt. Repeat
reconciliation of a saved receipt performs no GitHub calls.

The action does not dispatch, bill, cancel, renew, release or replace a claim and
does not authorize a retry. No task instructions, repository, run ID, attempt or
principal are accepted from request JSON. Empty-object input is stream-bounded to
256 bytes. Cross-origin and cross-site requests are refused; JSON content type
prevents a simple cross-site form submission. Responses are no-store and fixed
errors do not include credentials or upstream bodies. Browser requests have a
30-second deadline; failed acknowledgements tell users to refresh saved history
before checking again, without retrying execution.

Reuse: existing account/session auth, tenant membership, task-request correlation,
execution claims, GitHub App/platform credentials, native workflow metadata matching,
terminal job verifier, immutable receipt table, audit events and Saved requests UI.
No new migration, worker, agent framework or inference router. Migration 0020 and
its predecessors remain prerequisites. Active cloud-missions PR #291 is separate;
no mission, shared PROGRESS or concurrent root-checkout files were changed.

## Limits and next work

This is user-triggered observation, not a background reconciler or an unattended
scheduler. Pending/unavailable evidence stays unconfirmed, and absent claims cannot
be inferred from run timestamps. Renamed jobs, incomplete metadata or more than
100 jobs fail closed under #289's verifier. A verified GitHub conclusion is not
proof of code validation, absence of external effects or readiness for another run.
The original claim remains reserved even for failed/cancelled outcomes.

No production migration, deployment or live GitHub end-to-end acceptance is claimed.
Physical mobile interaction remains unverified. Owner review is required for this
authorization boundary. Next: controlled background observation with deduplication,
rate budgets and audit, then an explicitly approved recovery policy considering
external effects; do not automatically restart a failed or cancelled run.

## Executed validation

Production Worker build, lint, corrected typecheck and all 517 web tests passed.
Six new tests cover exact GitHub attempt verification, cached observation without
network calls, no fabricated agent report, delayed reporting, tenant/principal
isolation, snapshot races, audit rollback, mobile request shape and the built HTTP
boundary. The HTTP test uses real signed account sessions and migrated SQLite;
remote GitHub responses are mocked. A missing test-adapter raw method was corrected
using the same wrapper as existing auth tests; production auth was unchanged.
Three guard mutations (exact run metadata, no fabricated report and cached reads)
caused assertion failures and were restored before the full suite. Final committed
diff checks and repository CI are recorded on the PR/claim issue. No live production
or physical mobile verification is inferred.
