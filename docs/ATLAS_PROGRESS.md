# Atlas master implementation progress

## 2026-10-17 — request recovery integration (#275 / #276)

Propagated main 1e0909f through existing dispatch and deduplication parents;
preserved atomic monthly admission, current account/native changes and both
appended handoffs. The parents' preceding heads passed all 13 CI jobs; their
new integrated heads and this recovery revision require fresh CI.

Fixed stale Saved requests responses after close/reopen, refresh, paging,
version changes and unmount. Poll/list/detail reads are single-flight and a
batched close/reopen always starts a new session. Reuses the existing read API,
request receipts and correlation lookup; no automatic dispatch or billing retry.

Six initial regressions failed on the original component; nine final component
tests pass. Final build, typecheck, full lint and complete web suite pass: 541 total, 537 passed,
four optional skips. Separately executed actual headless Edge desktop/mobile
acceptance passes; no physical phone or production acceptance is claimed.
Existing scoped SQLite/built Worker snapshot and zero-external-call guards pass.

Next: publish #276 validation and fresh CI/review, then integrate #278 execution
claims and #282 result ownership against this parent. Native cloud worker,
production migrations, capacity-wait recovery and live business acceptance
remain open. No production data, credentials or infrastructure changed here.

## 2026-10-17 — inference merged; durable cloud stack integration

PR #307 merged as af500709 after exact-head CI 39007161939 passed all 13
jobs. Its source/test changes are now on main. Historical local failures below
remain recorded; passing CI is not a claim that the local broad run passed.
The same Genesis approval test passed alone on both main and the inference branch.

Existing PR #270 now integrates main, preserves Genesis/privacy routing, and
enforces dispatch acknowledgement deadlines even when a transport ignores abort.
It retains uncertain state without retry and cancels/discards late responses.
Worker build, typecheck, targeted lint and whitespace checks passed; full web
suite: 507 total, 505 pass, 2 optional skips, no failures. Runtime fix: f131c34.
Fresh CI and the existing tenant-persistence review gate remain required.

The updated parent was merged into existing #274. Its fresh Worker build and
typecheck and full web lint pass; full web suite: 517 total, 515 passed, two optional skips, no
failures. Same-key admission and authenticated reconnect/replay checks pass.
Fresh CI and tenant-persistence review remain open. No replacement deduplication/billing system,
production migration, live task dispatch, paid provisioning or deployment.
Next: complete #270/#274 CI and review, then propagate into #276, #278, #282.

## 2026-10-16 — inference stream integrity (#300)

Base main `1c3be5b`, isolated branch `codex/inference-quota-reliability`, worktree
`.worktrees/inference-quota-reliability`. Owner checkout preserved.

Implemented LF/CRLF/CR event framing, multiline SSE data, UTF-8 chunk retention,
completion receipts, malformed/oversized event rejection and reader cleanup.
EOF without a finish frame or DONE sentinel now fails before releasing tool
calls. Empty/reasoning-only streams cannot emit successful completion.
Partial text remains visible as incomplete. No automatic external-action retry.

Changed source: `apps/local-control/src/agent/model-client.mjs`.
New tests: `apps/local-control/tests/model-stream.test.mjs`.
New master audit, roadmap, progress, test results and deployment documents.

Evidence: eight initial negative tests failed on original code (including actual
HTTP CRLF); 54 focused tests then passed. Actual SQLite close/reopen proves an
interrupted call leaves the objective retryable and executes no tool. This does
not prove safe replay after a tool already executed earlier in a task.
Existing inference foundation passes 63/63. Reviewable PR:
https://github.com/cornerstonemarketingus/atlas/pull/307 (commit f8f894e).
CI run 38995719143 finished with all 13 jobs passing, including Windows.
Local full suite finished: 707 passed, 6 failed, 20 skipped (733 total).
Current-main focused retest: 81 passed, 3 Genesis timeouts (84 total).
The inference and desktop cases pass; Genesis timing/load causality remains
unresolved. See ATLAS_TEST_RESULTS.md. This checkpoint preceded the #307 merge
recorded above.

Current-main CI is green; historical Windows startup failure is not reproduced
as a current production defect. The first sandboxed boot attempt could not
complete due to restricted subprocess/network access; do not count it as passed.

Remaining: durable cloud PR integration, universal inference wait/resume and
spend enforcement, native cloud executor, real-provider/business/phone acceptance.
No deployment, migration, production data mutation, secret transfer or paid
provisioning performed. Next: fresh CI after merging main 9443843 into this
branch, then durable-dispatch #270 integrated-main deadline regressions. Main's
newer source and both progress handoffs were preserved during conflict resolution.
