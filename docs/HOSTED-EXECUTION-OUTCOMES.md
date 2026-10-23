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

## 2026-10-21: restore live run-title receipt verification (issue #432)

Release #372 merged and reached Cloudflare in successful deployment 39522378601.
Its hosted inspection 39522548783 and coder 39522564249 checks dispatched tasks,
but timed out waiting for result delivery. Their execution jobs succeeded; report
jobs failed. Direct GitHub metadata identified the mismatch: job `workflow_name`
contained `Atlas Coder · task <taskId>` / `Atlas Runner · task <taskId>`, whereas
the verifier expected only the static workflow name. The former test fixtures
therefore accepted a shape that did not represent these production responses.

The verifier now derives the exact title from the saved task and requires both
the verified run's `display_title` and job's `workflow_name` to match it. Exact
run/attempt, terminal status, commit, execution job and immutable scoped storage
checks remain. Static names, foreign tasks and mismatched titles are refused.
No claim is released, execution retried, or permission expanded by this repair.

Sanitized metadata from runs 39522587428 (coder) and 39522571343 (inspection)
forms a regression that failed before the repair. Built-Worker, reconciliation
and scheduled-observer fixtures now use the real task-specific title. Explicit
credential-redirect tests remain, and the source scan uses native file URL
conversion and fails on inaccessible source directories, including on Windows.
Two weakened title guards and the redirect scan each caused assertion failures.
Combined build, full-suite CI and renewed live acceptance are recorded on the PR;
the prior deployment success is not a successful end-to-end acceptance claim.
