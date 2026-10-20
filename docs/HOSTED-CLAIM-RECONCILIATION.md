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

## 2026-10-19 — verification follow-through (#289, includes merged #312)

Resolved-tree production Worker build and typecheck pass. Complete local web
suite: 604 total, 599 passed, five optional browser skips, zero failures. Separate
real Edge acceptance passed at 1280x800 and 390x844, including explicit receipt
reconciliation, one POST with no client-selected run, a verified failure display,
44px controls and no page errors. This uses controlled GitHub/API fixtures; it
is not a physical-phone or live-provider acceptance result.

The new deadline test failed before the fix and passed after combining the
navigation signal with the existing 30-second timeout. Navigation fencing does
not cancel committed evidence or authorize execution. Eleven workflow checks
pass. Parent #282 at fc2d324 has all thirteen CI jobs green; #289 source d820c47
has twelve green jobs and Windows local-control still running at this checkpoint.
Fresh CI is required for the final documentation/browser-test commit. Local lint
is still pending; CI web lint passes. Historical failed overlapping-merge build
and the initial deadline regression remain recorded as failed evidence.

No migration, production deployment, credentials, paid compute or production data
changed. Owner/security review remains required for the receipt and tenant
boundary. Migration 0020 must follow reviewed 0019. Next: finish fresh #289 CI and
review; then inspect existing #284 Genesis receipt recovery (still open on main)
without overwriting its active worktree. No retry/takeover authority is implied.


Local verification completion (2026-10-19): full web ESLint finished with exit 0,
build/typecheck and all 599 executed web tests pass. The five browser skips were
optional configuration skips; separately configured desktop/mobile Edge acceptance
passed. Latest PR CI and protected review remain independent gates.

