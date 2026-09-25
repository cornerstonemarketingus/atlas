# Atlas — current state (2026-09-25)

Audited on branch `claude/atlas-platform-development-o9znpd` at base `1cabfe6`
(merge of PR #58). Everything below was re-checked against code, CI and test
runs on that date; older handoff documents were compared, not trusted.

## Verdict

**Atlas is operational.** Nothing on `main` is broken: every test suite
passes locally, CI and the Cloudflare deploy are green on the latest merge,
and the hosted verification workflow last passed on 2026-09-23. The
"Atlas may be unusable" hypothesis in the mission brief did not reproduce. See
`RECOVERY.md` for the one user-visible failure mode that did (a vague coder
objective burning its turn budget).

What Atlas *is* short of is not stability but connection: many foundations
built in PR #55 are libraries the running daemon never loaded. This branch
starts wiring them in, beginning with the agent organization.

## Evidence

| Check | Result | How |
|---|---|---|
| `packages/atlas-cli` | 424/424 pass, `tsc` clean | `npm ci --ignore-scripts && npm run build && npm test` |
| `apps/web` | 131/131 pass, lint clean, build clean | `npm ci && npm run lint && npm test` (test runs `vinext build`) |
| `apps/local-control` | 276/276 pass at base; 285/285 on this branch | `npm test` |
| `packages/atlas-contracts` | 6/6 | `npm test` |
| `scripts/runner`, `scripts/local` | 36/36 | `node --test scripts/runner/*.test.mjs scripts/local/*.test.mjs` |
| Workflow syntax | 9/9 parse | `python3 .github/atlas/check-workflows.py` |
| CI on `main` @ `1cabfe6` | success | GitHub Actions run 36094154400 |
| Deploy on `main` @ `1cabfe6` | success | GitHub Actions run 36094154479 |
| Hosted verification | success (2026-09-23) | `verify-hosted.yml` run 35933533306 |
| Live URL probe from this environment | not possible | egress proxy returns 403 for `*.workers.dev` from this container; relied on `verify-hosted.yml` instead |
| Latest Atlas Coder run | failed: `blocked: Turn limit reached` | run 36088414372, objective "hi can u debug yourself? …" |

## PR #55 and open PRs

- PR #55 (Atlas OS foundations: contracts, durable task store, policy engine,
  budgets, authorized executor, browser worker, terminal controller, family
  graph, typed messages, MCP gateway, scoped memory, model router, Ollama) is
  **merged** into `main` (commits `afc2769`…`ff9eb9d`).
- PRs #52 and #54 are open, Atlas-generated smoke checks that each add a
  one-line `docs/ATLAS-SMOKE-CHECK.md`. They are verification artifacts of the
  hosted coder loop, duplicates of each other, and carry no product value.
  They were left untouched (no auto-merge, no close) — the owner should close
  them.

## Component status

Legend: **IMPLEMENTED** (wired into a running entry point and tested),
**DISCONNECTED** (implemented and tested but nothing running loads it),
**PARTIAL**, **BROKEN**, **OBSOLETE**, **MISSING**.

| Area | Status | Evidence |
|---|---|---|
| Hosted control plane (auth, tasks, billing, chat, computer tasks) | IMPLEMENTED | `apps/web/app/api/**`; 131 tests |
| Hosted coder loop (Actions runner → verified PR) | IMPLEMENTED | `atlas-coder.yml`, `scripts/runner/*`; PRs #52/#54 prove it end to end |
| Verified coder session (baseline → edit → re-verify → repair) | IMPLEMENTED | `packages/atlas-cli/src/agent/verified-coder-session.ts` |
| Local daemon, sessions, leases, recovery | IMPLEMENTED | `apps/local-control/src/main.mjs`, `agent/runtime.mjs` |
| Mission DAG scheduler | IMPLEMENTED | `agent/mission-scheduler.mjs`, wired `main.mjs` |
| Platform task store + outbox + read-only dashboard | IMPLEMENTED (store, events, dashboard); DISCONNECTED (outbox has no dispatcher/consumer) | `platform/task-store.mjs` `claimOutbox` has no caller in `src/` |
| Policy engine + authorized executor | DISCONNECTED | `platform/policy.mjs`, `platform/executor.mjs` — used only by tests and the browser vertical slice fixture |
| Agent family graph, delegation, typed messages | **IMPLEMENTED on this branch** (was DISCONNECTED) | now loaded by `platform/innovation/bootstrap.mjs` from `main.mjs` |
| Business Development / Product executives, Innovation Backlog | **IMPLEMENTED on this branch** (was MISSING) | `platform/innovation/*`, `/innovation`, `/v1/innovation/*` |
| Scoped memory store | DISCONNECTED | `platform/memory/*` — no import outside tests |
| MCP gateway | DISCONNECTED | `platform/mcp/*` — no import outside tests |
| Capability model router (platform) | DISCONNECTED; the older `agent/models/router.mjs` is used only for `describeRoutes` | `main.mjs` |
| Terminal controller (platform) | DISCONNECTED | `platform/terminal/*` |
| Browser worker package | IMPLEMENTED as package + vertical-slice test; not the daemon's default browser | `apps/browser-worker` |
| Desktop control | MISSING | no UIA/xdotool code |
| Project Genesis (prompt → requirements → plan → app) | MISSING | — |
| Visual builder / live preview with source mapping | MISSING | roadmap only |
| Deployment adapters | PARTIAL (Cloudflare/Vercel/git-host plan/apply/rollback adapters exist in local daemon) | `agent/infrastructure/*` |
| Time-based / event-driven automations | PARTIAL (GitHub cron for self-improve only) | `atlas-self-improve.yml` |
| Tenant model | MISSING (principal string only) | `apps/web/db/schema.ts` |
| Legacy Python prototype | OBSOLETE (documented as such) | `src/atlas_agent` |

## Security review backlog

| # | Gap | Status |
|---|---|---|
| SEC-5 | Hosted approval consumption not atomic | **Fixed on this branch** — conditional update with `.returning()`; decisions on expired approvals refused |
| SEC-6 | Operator bearer compared with `===` | **Fixed on this branch** — SHA-256 + `timingSafeEqual`; rate limiting still open |
| SEC-14 | Two workflows without `permissions:` | **Fixed on this branch**, and `check-workflows.py` now fails any workflow that omits it |
| SEC-1, 2 | Tenant model, revocable sessions | Open (High) — required before multi-tenant expansion |
| SEC-3 | SSRF in daemon browser tools | Partially addressed in `apps/browser-worker` egress policy; daemon tools still scheme-only |
| SEC-4 | Local coder env inheritance | Fixed in PR #55 (`P3-2`) |
| SEC-7…13, 15, 16 | See `SECURITY-REVIEW.md` | Open |
