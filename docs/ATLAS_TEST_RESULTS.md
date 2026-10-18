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
