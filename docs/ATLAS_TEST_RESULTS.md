# Atlas verification results

Date: 2026-10-16. Node v24.14.0 on Windows; CI pins Node 22.

| Check | Result | Scope |
|---|---|---|
| Baseline model-stream regressions, original source | 0/8 pass | Confirmed defects; actual loopback HTTP included in escalated rerun |
| Focused model-stream, conversation, model suites | 54/54 pass | 11 new stream checks, actual HTTP and SQLite restart; no live AI credentials |
| Inference foundation | 63/63 pass | Existing quota, circuit, error, fingerprint and registry tests; mocked provider boundaries |
| git diff --check | Pass | Whitespace only |
| Full local-control | Pending | Log `.stream-suite.log`; do not infer success from focused checks |
| Latest main CI 38991786626 | All 13 jobs pass | Main 1c3be5b, not this branch |
| Branch CI / live model / production | Pending / not run / not deployed | Required before completion claims |

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
