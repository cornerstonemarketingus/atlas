# Atlas parallel workstreams

Each workstream is sized for one Claude Code session. They own **disjoint
files**, so several can run at once without merge conflicts. Start every
session from the latest `main`, work on its own branch, run the listed tests,
and open a PR. Do not auto-merge or deploy.

Shared rules for every workstream:

- `apps/local-control` stays zero-dependency (Node 22, `node:sqlite`, `node:test`).
- Import contracts from `packages/atlas-contracts/src/index.mjs`; do not change them without a separate PR.
- Every tool goes through `AuthorizedToolExecutor` (policy → budget → audit). Default deny; role labels grant nothing.
- Success is proven by tool output and tests, never by prose.
- Run `cd apps/local-control && npm test` (plus the suite named below) before opening a PR.

Status key: ✅ merged · ☑️ done on `claude/atlas-implementation-eah694` (tests green, not yet merged) · 🔄 an agent is building it now · ⬜ not started.

## Already merged (PR #55)

✅ Contracts, task store, policy engine, budgets, authorized executor · ✅ Playwright browser worker + verified vertical slice · ✅ Terminal controller (process-level) · ✅ Agent family graph · ✅ MCP stdio gateway · ✅ Scoped memory + model router + Ollama adapter · ✅ Read-only task dashboard · ✅ Correlation IDs through coder dispatch · ✅ Phase 0 audit docs.

## Workstreams

| # | Workstream | Owns (files) | Acceptance | Status |
|---|---|---|---|---|
| 1 | **Security fixes** | `apps/local-control/src/agent/tools/browser-tools.mjs`, `src/agent/browser/**`, `src/runner.mjs`, `src/net/ssrf-guard.mjs`, `scripts/local/**`, `apps/web/app/api/computer/**`, `apps/web/app/api/tasks/operator-auth.mjs`, `apps/browser-worker/src/address-guard.mjs` | Private/metadata addresses blocked (incl. DNS rebinding in the browser worker); local coder gets an allowlisted env; hosted approval consumed atomically (concurrent test: exactly one wins); operator token compared in constant time | 🔄 |
| 2 | **Orchestrator** | `apps/local-control/src/platform/orchestrator/**` | Task DAG with cycle refusal; outbox dispatcher with backoff + dead-letter + escalation; cron/event scheduler with dedup; model-driven agent loop that cannot complete without verifier evidence; replay report; pause/cancel propagation; restart recovery | 🔄 |
| 3 | **Platform API + command center UI** | `src/platform/api-routes.mjs`, `src/platform/dashboard.mjs`, `src/server.mjs`, `src/main.mjs` | Authenticated `/v1/platform/*` write API (tasks, approvals, family, memory, costs, workers, emergency stop); `/platform` UI with composer, approvals inbox, family tree, costs, worker health, memory inspector, "why blocked" | 🔄 |
| 4 | **Desktop control** | `src/platform/desktop/**` | Enrollment + approved short-lived sessions + visible indicator + emergency stop + audit; observe→act→verify loop; simulated desktop passes "moved window" recovery; Xvfb adapter reports real capabilities | 🔄 |
| 5 | **Terminal isolation** | `src/platform/terminal/**` | `namespaces` backend (no network, own PID namespace, read-only root, non-root uid) verified by tests; `docker` backend detected; honest `isolation` report | 🔄 |
| 6 | **Engineering workflow** | `src/platform/engineering/**` | Per-agent worktrees; file-ownership + conflict escalation; inspect→criteria→plan→code→checks→diff/security review→PR payload; no merge capability exists | ☑️ |
| 7 | **MCP HTTP + Atlas MCP server** | `src/platform/mcp/**`, `src/platform/mcp-server/**` | Streamable HTTP client with enforced credential scopes + SSRF guard + reconnect; Atlas MCP server (stdio + HTTP) for status/list/create-proposed-task | 🔄 |
| 8 | **Skills marketplace** | `src/platform/skills/**` | Signed (ed25519) versioned skill packages; install needs trusted signature + passing tests + approval; rollback; agent proposals never self-install; workflow templates from verified tasks; redacted knowledge exchange | ☑️ |
| 9 | **Web multi-tenancy + sessions** | `apps/web/db/**`, `apps/web/drizzle/0014+`, `apps/web/app/api/auth/session.mjs`, `settings/**`, `github/**`, `conversations/**`, `tasks/route.ts` | Tenants + memberships; tenant-scoped queries with cross-tenant tests; revocable server-side sessions; shorter TTLs; migrations with deploy order | 🔄 |
| 10 | **Planning, voice, federated workers** | `src/platform/planning/**`, `src/platform/voice/**`, `src/platform/workers/**` | Verified-performance team selection; cost-aware plan ranking; debate judged by executable checks; voice commands with bound spoken confirmation; worker registry with trust levels; per-task observability rollup | 🔄 |

## Next wave (not started — good candidates for new sessions)

| # | Workstream | Owns | Acceptance | Depends on |
|---|---|---|---|---|
| 11 | Wire subsystems into the daemon runtime | `src/main.mjs`, new `src/platform/runtime-wiring.mjs` | Orchestrator dispatcher + scheduler run in the daemon; browser/terminal/desktop/MCP tools registered with the executor under one policy file | 2, 3 |
| 12 | Policy file + admin UI | `src/platform/policy-config/**` | Versioned policy document on disk, validated on load, edit via API with audit | 3 |
| 13 | Execution replay UI | `src/platform/dashboard.mjs` (replay section only) | Step-through timeline from the replay report, with cost | 2, 3 |
| 14 | Human take-over of browser/desktop sessions | `apps/browser-worker/src/takeover.mjs`, `src/platform/desktop/takeover.mjs` | Pause agent, hand live session to user, return control with audit | 4 |
| 15 | Model capability benchmark run | `src/platform/models/benchmarks/**` | Run capability suite against configured local/cloud models; store measured profiles | — |
| 16 | Load and tenancy tests | `tests/load/**` | Concurrent tasks, budget and isolation hold under load | 9, 11 |

Cortex / construction is out of scope for this repository.
