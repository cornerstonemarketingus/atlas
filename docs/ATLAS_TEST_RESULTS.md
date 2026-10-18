# Atlas verification results

Date: 2026-10-16. Node v24.14.0 on Windows; CI pins Node 22.

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
