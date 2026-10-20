# Atlas master implementation progress

## 2026-10-17 — execution-claims integration (#277 / #278)

Integrated the validated #276 recovery parent, retaining current main's atomic
billing, authorized coder provider fallback and all claim/workload/report gates.
RequestHistory retains both the new response fencing and claim metadata display.
No protected merge or policy weakening occurred.

Final Worker build/typecheck/full lint pass; full web suite: 545 pass, four optional skips,
no failures (549 total). All nine inherited recovery race guards pass. All 83
runner/local-script tests and all ten mandatory workflow checks pass. The checker
used bundled Python with PyYAML in ignored scratch space and installed Git Bash.
No application dependency was added. The inherited #276 parent 5a9ba04 passed
all 13 CI jobs; fresh integrated claims CI remains required.

Fresh integrated claims CI and protected workflow/identity review remain open.
JWT/key/run HTTP responses are controlled test fixtures, not a live cloud run.
Next: integrate #282 result ownership against this parent; retain migration
0019, rollout quiescence and existing sandbox/approval requirements. No production
migration, credential transfer, real dispatch, provisioning or deployment.

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

## 2026-10-19 — Genesis receipt integration checkpoint (#281 / #284)

Integrated current main afdee04, preserving hosted website creation, scoped
preview reads, project-stage UI, bounded bridge deadlines, and existing approvals.
Node dispatch reserves its original operation id before calling the node. Hosted
creation reserves its actual gen_ operation id before returning an existing row
or writing a site. Missing/foreign/archived history prevents creation. Reopening
history restores only bounded operation ids; status checks never create projects.
Retained main's preview UI while restoring bounded polling, cancellation, explicit
read-only retry and truthful not-found diagnostics. Added a real SQLite hosted
fallback recovery/refusal regression. Twenty focused project cases pass. All
11 workflow checks pass. Build/full web tests, typecheck, lint and fresh CI are
pending; no live node, external repository creation, publish or deployment claimed.

Separate #289 CI at 6ac1336 failed Windows: 828 pass, two failures, 20 skips.
Main already repairs the Genesis acceptance fixture. Updated daemon/Genesis
reproduction passes all 11 cases in a serial Windows run; full parallel Windows
CI remains a gate. Earlier all-green source heads do not replace this evidence.
No production migration, credential transfer, data change or paid provisioning.
Next: complete current-head CI and protected persistence review before rollout;
configure a trusted Genesis node only with the required owner authorization.

## 2026-10-19 — Genesis receipt verification follow-through

Integrated build and typecheck pass. Full web acceptance: 624 total, 619 passed,
five optional browser skips, zero failures. Separate Edge desktop/mobile chat
acceptance passes: reopen/reload restores the receipt, offline status retry is
read-only, no project creation POST occurs, and scroll position is preserved.
Twenty-six focused chat/project cases pass. Full ESLint passes after removing
an unused default callback argument. CI b02ca55 failed at that lint error; it did
not reach the incomplete chat test host. The host now imports the real receipt
helper. Final history-refusal diagnostics and no-write assertions pass 16 focused
cases; final head CI remains required. No assertion or authorization was removed.

#289's current-main integration exposed an unsupported Worker redirect mode in
three verification calls; the separate outcome branch now uses manual redirects
and rejects non-success responses. Its source scanner is corrected to inspect
real files on Windows. Both fixes retain original ownership and approval gates.
No live node, physical phone, production write, migration or deployment claimed.
Next: finish exact-head CI/protected review for #284 and #289, then a configured,
explicitly authorized Genesis-node acceptance run without publishing by default.
