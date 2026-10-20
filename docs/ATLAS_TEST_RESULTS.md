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
