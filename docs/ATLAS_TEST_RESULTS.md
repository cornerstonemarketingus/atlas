# Atlas verification results

Evidence dates: 2026-10-16–17. Node v24.14.0 on Windows; CI pins Node 22.

| Check | Result | Scope |
|---|---|---|
| Baseline model-stream regressions, original source | 0/8 pass | Confirmed defects; actual loopback HTTP included in escalated rerun |
| Focused model-stream, conversation, model suites | 54/54 pass | 11 new stream checks, actual HTTP and SQLite restart; no live AI credentials |
| Inference foundation | 63/63 pass | Existing quota, circuit, error, fingerprint and registry tests; mocked provider boundaries |
| git diff --check | Pass | Whitespace only |
| Full local-control, original branch | 733 total: 707 pass, 6 fail, 20 skip | Five Genesis creation failures and one desktop timing assertion; `.stream-suite.log`; not green |
| Latest main CI 38991786626 | All 13 jobs pass | Main 1c3be5b, not this branch |
| Branch CI 38995719143, commit f8f894e, PR #307 | All 13 jobs passed | Includes Windows, real Genesis coder/browser, Linux full local-control, web, CLI and inference; current-main merge needs fresh CI |
| Integrated inference CI 39007161939, commit 906158a | All 13 jobs passed; #307 merged as af500709 | Exact-head checks verified before ordinary merge |
| Integrated dispatch #270 Worker and full web suite | Build passes; 505 pass, 2 skip, 0 fail (507 total) | Actual migrated SQLite and built authenticated Worker routes; external GitHub transport simulated |
| Dispatch typecheck, targeted lint, whitespace | Pass | New enforced-deadline and late-response regressions included in full suite |
| Integrated request deduplication #274 | Build/typecheck/full lint pass; 515 pass, 2 skip, 0 fail (517 total) | Same-key admission and built authenticated Worker reconnect/replay; GitHub transport simulated |
| Current-main request recovery #276 | Final build/typecheck/full lint pass; 537 pass, 4 skip, 0 fail (541 total) | Includes atomic billing, scoped inspection, unchanged storage snapshots and zero external-call guards |
| Request-history component races | 9/9 pass | Initial six cases failed on original source; batched-toggle guard also failed before its fix; real TSX with cancellation-ignoring deferred reads |
| Request-history actual browser | 1/1 pass across desktop and phone widths | Headless Edge, actual React component and GET client with controlled API; separate from the optional full-suite skip |
| Integrated execution claims #278 | Build/typecheck/full lint pass; 545 pass, 4 skip, 0 fail (549 total) | Real JWT signatures, migrated SQLite, controlled GitHub keys/run metadata and built Worker claim boundary |
| Recovery #276 head 5a9ba04 CI | All 13 jobs passed | Includes Linux/Windows local control, web, real Genesis coder/browser and workflow checks; claims revision still needs fresh CI |
| Integrated claims runner/local scripts | 83/83 pass | Admission acknowledgement recovery, no repeated execution, stale-attempt/lease guards and current coder routing |
| Mandatory workflow checker | All 10 pass | Original checker, bundled Python, scratch PyYAML and installed Git Bash; no checker weakening |
| Current-main focused follow-up | 84 total: 81 pass, 3 Genesis creation timeouts | Transport/conversation/model and desktop cases pass; local Genesis issue remains unresolved |
| Unchanged local-control main, single Genesis approval case | 1/1 pass | `.baseline-project-check.log` in durable-dispatch worktree; does not establish full baseline parity |
| Live model / production | Not run / not deployed by this session | No production acceptance claim |

Commands from repository root:

    node --test apps/local-control/tests/model-stream.test.mjs apps/local-control/tests/conversation.test.mjs apps/local-control/tests/models.test.mjs
    node --test apps/local-control/tests/*.test.mjs

Acceptance proven here: CRLF text/tools/usage survive actual HTTP; every split
position in a UTF-8/CRLF fixture preserves text; EOF inside a tool response
emits neither tool call nor done; empty/reasoning-only and malformed events fail;
DONE stops and closes a still-open reader; restart preserves failed objective,
recoverable diagnostics and explicit retry without executing the partial call.

Not established: live provider reliability, deployed cloud claims, fallback
privacy/capability qualification, safe replay after earlier consequential tools,
Linux container isolation, live mobile approvals or real-model website quality.

2026-10-17: the full local run finished in 804.6 seconds with six failures.
The smaller current-main follow-up took 184.5 seconds and retained three
Genesis timeouts. Timing/load dependence is suspected, not proven; local
success is not inferred from CI. No timeout assertions were relaxed.

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

