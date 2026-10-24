# Hosted result execution ownership

Issue #280; stacked on execution claims #278. Audit date: 2026-10-15.

Before this change, the result callback checked a signed GitHub identity and live
run metadata, but did not consult the durable execution claim. A later run attempt
could submit a result for the same task. Conversation lookup also matched principal
without requiring its tenant to match the task.

The existing `/api/tasks/result` callback now requires the immutable executor
repository identity for nonlegacy dispatches. Its D1 write transaction checks the
saved tenant, principal, conversation, correlation, dispatch state, workflow mode,
repository and exact claimed run/attempt on every write. Unclaimed new dispatches
and competing attempts return 409 without inserting a result. Redirects during
privileged GitHub run verification fail closed.

The existing stable result IDs preserve first-delivery content on replay. The
message, run event, task linkage and conversation update share one D1 transaction.
Expired claims may deliver reports for the same attempt; reporting grants no
execution authority and does not renew, release or replace the claim. Only tasks
explicitly marked `legacy` may report without a claim, and an existing claim takes
precedence even for those rows. Conversation and task tenants must match, including
matching nulls for genuinely legacy rows.

Reuse: existing GitHub OIDC verifier, GitHub App credentials, live run matching,
D1 batch transactions, task records, conversation messages and result audit events.
No new migration, queue, router, executor or dependency. Migration 0019 from #278
is required before deploying; missing storage returns 503 with a generic message.

Reports remain executor-authored summaries, not independent proof that tests
passed or business outcomes occurred. This increment does not attest terminal
job status, permit retries, resolve claims, or recover failed workloads. Next:
verify trusted execution-job conclusions and persist authenticated outcome receipts
before introducing any audited recovery policy. Owner review is required for this
security boundary. No production migration, deployment or live OIDC test is claimed.

Validation includes real SQLite transactions and the built Worker HTTP endpoint
with real RS256 signatures and mocked official JWKS/GitHub responses; it covers
replay, stale attempts, unclaimed dispatches, tenant/principal mismatch, snapshot
changes, rollback and missing migrations. Shared PROGRESS is being edited by
other open work; this focused handoff and issue avoid overwriting their changes.

Executed validation: 504/504 web tests passed after the production Worker build;
all six new focused tests passed. Web lint and type checking passed. Three guard
mutations (claim required, exact attempt, matching conversation tenant) each
caused assertion failures and were restored before the full suite. `git diff
--check` passed. GitHub CI results are reported on the PR; local HTTP tests use
mocked remote services and do not constitute production verification.

## 2026-10-17 — result ownership integration checkpoint (#282)

Integrated main 482948b through #270/#274/#276/#278 into the existing result
ownership implementation. Added a built-Worker callback regression that changes
the saved objective during GitHub verification and requires 409, no result writes,
and no run linkage. Existing transaction ownership checks remain authoritative.
Reports are executor-authored summaries, not verified successful outcomes.

All ten workflow checks pass. Runner/local suite: 86 pass, one failure, one
Linux-only skip (88 total); isolated process suite: five pass, two fail, one
Linux-only skip. Windows inherited-pipe deadline and observer timing remain
unresolved. Do not relabel these failures as a passing acceptance run.
Fresh validation: production Worker build and typecheck pass; complete web suite
551 pass, four optional browser skips (555 total), including all six result tests
and the callback race. Dependencies were copied from the verified parent after a
stalled npm ci; lockfile SHA-256 values match. Initial incomplete-install checks
failed to find binaries. Corrected regression preserves the run linkage already
established by the claim. CI at 39cadb3 passes web build/tests/lint and eleven other
jobs; Windows local-control remains pending at this checkpoint. Local full lint
is still running. No live-provider or physical-phone acceptance is inferred.
No production migration/deployment, live OIDC, paid infrastructure or secret
transfer occurred. Migration 0019 and protected owner review remain required.
Next: finish #282 web validation and fresh CI; then #289 trusted outcome receipts.
