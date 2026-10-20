# Verified hosted execution outcomes

Issue #286; based on result ownership #282 and execution claims #278.
Audit date: 2026-10-15.

## Existing boundary and change

Atlas already authenticated GitHub result callbacks, checked live workflow metadata,
and bound transactional report writes to a saved tenant/principal execution claim.
The stored summary was still executor-authored prose: no durable record distinguished
a completed execution job from a report that claimed it completed.

The real `/api/tasks/result` route now reads GitHub's attempt-specific job listing
with existing GitHub App/platform credentials after signed run verification. It
requires exactly one job named `run`, the current native execution job ID in both
Atlas Coder and Atlas Runner workflows. It checks the run, attempt (when returned
by GitHub), main branch, workflow name, exact head commit, terminal status, supported
conclusion and completion timestamp. The attempt-specific endpoint scopes responses
even when individual job records omit `run_attempt`. Incomplete pagination, duplicate
matches, pending jobs and unavailable evidence fail closed. No conclusion from
request JSON, artifacts or model text is trusted. The overall workflow need not be
finished: its isolated reporting job is still running during delivery.

API contract: [GitHub workflow job documentation](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt).
The existing read permission is sufficient; no additional secret or workflow change.

## Persistence and mobile reads

Migration `0020_task_execution_outcomes` adds a receipt keyed by claimed task, with
server-selected tenant/principal, run/attempt, GitHub job ID, head commit, conclusion,
completion time and Atlas verification time. Database triggers reject UPDATE and
DELETE. Every report write rechecks the task snapshot, conversation ownership and
claim inside one D1 batch. The receipt and a stable outcome audit event commit with
the message and report event. Duplicate delivery preserves the first receipt and
summary. Conflicting job metadata returns 409 without a partial update.

Saved requests join receipts through the exact tenant/principal/run/attempt claim.
The phone-friendly Build view displays the verified job conclusion and times, with
an explicit reminder that a job result neither proves code validation nor permits
a retry. Read-only inspection never creates an execution, changes a receipt or bills.

## Security, compatibility and rollout

Reuse: existing native GitHub executor, dedicated OIDC report verifier, immutable
repository identity, live run matching, scoped D1 batch guards, conversation audit,
and authenticated saved-request inspection. No new framework, router or provider.
Requests use HTTPS, redirect refusal and a ten-second timeout; upstream error bodies
and credentials are never included in callback errors. Existing bounded callback
transport retry remains unchanged. Legacy dispatches retain their old reporting
path without receiving a newly verified outcome. An expired claim can deliver an
outcome for its same attempt; recording it never renews, releases or replaces it.

Apply reviewed migration 0020 after 0019 before deploying this Worker. Missing
outcome storage fails with a generic 503, including the inspection path; it does not
silently invent an outcome. Owner review is required for the authorization boundary.
Shared PROGRESS is owned by concurrent open work; this focused document and the
claim issue preserve handoff evidence without overwriting that work.

## Limits and next work

A successful GitHub job is not independent proof of software correctness, completed
business actions or absence of external effects. No claim resolution, retry, takeover,
refund, production migration or deployment is implemented by this increment. Whole-
workflow cancellation may prevent its report job from running, leaving no receipt;
there is no background reconciler yet. Jobs exceeding 100 entries, renamed execution
jobs, unsupported conclusions or incomplete metadata require investigation. Physical
mobile interaction and live production OIDC remain unverified.

Next: authenticated, read-only reconciliation of saved claims when no reporting job
ran, then an explicitly audited recovery policy that considers external side effects.

## Executed validation

Production Worker build, corrected type checking and all 511 web tests passed.
Coverage includes three job-verifier tests and ten transactional/built-Worker result
tests. JWT signatures and SQLite transactions are real; remote GitHub/JWKS responses
are mocked. Four weakened guards (terminal status, commit binding, conflicting
conclusions and read-side attempt binding) caused assertion failures and were restored
before the full suite. No live production verification is inferred. Lint and CI
results are recorded on the PR/claim issue.

## 2026-10-18 — trusted execution outcomes integration (#286 / #289)

GitHub confirms #270/#274/#276/#278 are merged. #282 at 593fad5 passed all
13 CI jobs before this session. Current main e604174 also contains inference
foundations #129–133, quota wiring #158 and model-pool routing #160. Prior open
status inventories are historical. Main is now integrated through #282 into
#289; no second inference governor or execution backend was introduced.

Reused the existing attempt-specific GitHub job verifier, migration 0020,
immutable outcome receipt, transactional ownership guards and scoped mobile
reads. Improved callback diagnostics when outcome evidence is unavailable:
retry result delivery, never rerun the task. Retained the parent task-mutation
race and now require zero outcome receipts on refusal. Added a real-component
GET-only pending-to-verified-failure UI test with explicit validation/retry limits.
Sixteen verifier and request-history cases pass. Build/full web suite, typecheck,
lint and refreshed CI are pending at this checkpoint; no live OIDC or phone
acceptance is inferred. Migration 0020 follows 0019 and remains undeployed.
No production data, billing, credentials or paid infrastructure were changed.
Next: finish current-head verification/security review; then integrate existing
#284 Genesis receipt recovery; never infer permission for retry/takeover.

Concurrent integration: remote #289 advanced to 3ed8310 when #312 merged into
it. Merged that work without force-pushing. Reconciliation retains server-selected
claim identity and cannot start or bill tasks. Its UI now shares cancellation,
single-flight and response fencing with detail reads. Three new regressions cover
late success/failure after reopen and late completion after unmount. An earlier
build overlapped the UI merge conflict and failed; the resolved tree is rebuilding.
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

