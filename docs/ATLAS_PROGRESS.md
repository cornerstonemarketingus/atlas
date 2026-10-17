# Atlas master implementation progress

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
Existing inference foundation passes 63/63. Full local-control suite and remote
CI are pending; see ATLAS_TEST_RESULTS.md.

Current-main CI is green; historical Windows startup failure is not reproduced
as a current production defect. The first sandboxed boot attempt could not
complete due to restricted subprocess/network access; do not count it as passed.

Remaining: durable cloud PR integration, universal inference wait/resume and
spend enforcement, native cloud executor, real-provider/business/phone acceptance.
No deployment, migration, production data mutation, secret transfer or paid
provisioning performed. Next: finish suite/CI, then review #270 dependency stack.
