# Atlas OS — phased backlog (phases 0–9)

Derived from `AUDIT.md` and `SECURITY-REVIEW.md`. Sizes: **S** ≤1 day,
**M** 2–5 days, **L** >1 week. **Branch** column: ✅ = addressed on
`claude/atlas-implementation-eah694` (in progress), blank = not started.
Security gap numbers (`SEC-n`) refer to `SECURITY-REVIEW.md` §2.

## Phase 0 — Audit

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P0-1 | Repository-grounded audit | `docs/atlas-os/{AUDIT,ARCHITECTURE,SECURITY-REVIEW,BACKLOG}.md` exist; every status cites inspected paths | — | S | `docs/atlas-os/*` | ✅ |
| P0-2 | Add `packages/atlas-contracts` to CI | `ci.yml` job runs `node --test` in the package; fails on a broken test | — | S | `.github/workflows/ci.yml`, `.github/atlas/check-workflows.py` | ✅ (commit `ef5fc08` on this branch) |

## Phase 1 — Contracts, durable queue, audit, authz, budget

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P1-1 | Durable task store + transactional outbox | Task/step/tool-call rows and outbox row written in one `BEGIN IMMEDIATE`; transitions validated by `assertTransition`; relay delivers at-least-once; crash between commit and publish re-delivers on boot (test) | contracts | L | new `apps/local-control/src/platform/`; `src/main.mjs`; reuse patterns from `src/agent/session-store.mjs:129-140` | ✅ |
| P1-2 | Append-only audit stream (local + hosted) | Local audit/event tables have UPDATE/DELETE triggers like `src/store.mjs:52-53`; `/v1/import` cannot overwrite audit; hosted `audit_events` D1 table records sign-in, repo-policy edits, device pairing (SEC-9, SEC-12) | P1-1 | M | `src/store.mjs`, `src/server.mjs:105`, `apps/web/db/schema.ts`, new migration `apps/web/drizzle/0013_*.sql`, `app/api/settings/repositories/route.ts`, `app/api/auth/*` | ✅ (local part) |
| P1-3 | Deterministic policy engine | Pure function (actor, tenant, tool, risk, input digest, budget) → `allow/deny/require_approval` + `policyDecision` record; default deny; URL policy denies loopback/RFC1918/link-local unless allow-listed (SEC-3) | contracts | M | new `src/platform/`; wraps `src/agent/tool-registry.mjs:180-205`, `src/store.mjs` `policy()` | ✅ |
| P1-4 | Budget-enforced authorized tool executor | No tool runs without a recorded allow decision or consumed approval; budget charged before execution, whole increment rejected; `elapsedMs`↔`wallTimeMs` reconciled | P1-1, P1-3 | M | `src/agent/budget.mjs`, `src/agent/tool-registry.mjs`, `packages/atlas-contracts/src/index.mjs:249` | ✅ |
| P1-5 | Hosted auth hardening | Server-side session table with revoke-on-logout; owner/operator sessions ≤1 h; constant-time operator bearer compare; per-principal rate limit on `/api/tasks`, `/api/auth/*` (SEC-2, SEC-6) | — | M | `app/api/auth/session.mjs`, `auth/github/callback/route.ts:45-50`, `app/api/tasks/operator-auth.mjs:24`, `db/schema.ts` | |
| P1-6 | Atomic hosted approval consumption | Consume uses conditional `UPDATE … RETURNING`; zero rows → 409; decision route rejects expired approvals; concurrency test (SEC-5) | — | S | `app/api/computer/companion/approval/[id]/route.ts:19-23`, `app/api/computer/approvals/[id]/route.ts` | ✅ (`claude/atlas-platform-development-o9znpd`) |
| P1-7 | Least-privilege workflow permissions | `deploy-cloudflare.yml`, `provision-d1.yml` declare `permissions:`; `check-workflows.py` enforces a top-level block (SEC-14) | — | S | `.github/workflows/*.yml`, `.github/atlas/check-workflows.py` | ✅ (`claude/atlas-platform-development-o9znpd`) |
| P1-8 | Correlation id propagation | `cor_…` minted/accepted at `POST /api/tasks`, passed as dispatch input, validated in runner, stamped on `run_events` and result | contracts | M | `app/api/tasks/route.ts`, `dispatch.mjs:40-56`, `atlas-coder.yml` inputs, `scripts/runner/validate-inputs.mjs`, `report-result.mjs`, `runner-result.mjs` | ✅ |

## Phase 2 — Browser worker

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P2-1 | `apps/browser-worker` package | Disposable Chromium context per session, destroyed on close/timeout; implements page contract of `src/agent/browser/playwright-page.mjs`; speaks contracts; `local-control` gains no npm deps | contracts | L | new `apps/browser-worker/` | ✅ |
| P2-2 | Browser egress policy | Navigation and every request filtered by P1-3 URL policy (DNS-resolved); tests for 127.0.0.1, 169.254.169.254, 10/8, daemon port | P1-3, P2-1 | M | `apps/browser-worker/`, `src/agent/tools/browser-tools.mjs:28-39` | ✅ |
| P2-3 | Daemon ↔ browser-worker adapter | `browser.*` tools can target the worker; operator classification + approvals unchanged (`apps/windows-companion/src/operator/session.mjs`) | P2-1 | M | `src/main.mjs:156-196`, `src/agent/tools/browser-tools.mjs` | |
| P2-4 | Hosted browser consumer or removal | Either a real executor consumes `executionProvider=cloudflare` tasks, or the option is hidden; verify/replace `cloudflare-browser.mjs` endpoints against the real Browser Rendering API (SEC-10) | P2-1 | M | `app/api/computer/tasks/route.ts:52-58`, `app/api/computer/browser-plan.mjs`, `src/agent/browser/cloudflare-browser.mjs` | |

## Phase 3 — Terminal

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P3-1 | Terminal sandbox controller | Sessions with cwd confinement, env allowlist, timeouts, output caps, kill-on-cancel; commands evaluated by policy engine; transcript persisted as events | P1-1, P1-3 | L | new `src/platform/`; reuse `src/agent/tools/process.mjs`, `tools/path-confinement.mjs` | ✅ |
| P3-2 | Scrub local coder environment | `runLocalCoder` and `run-coder.mjs` pass `safeEnvironment()` + model key only; test asserts `ATLAS_GITHUB_TOKEN` absent in child (SEC-4) | — | S | `src/runner.mjs`, `scripts/local/run-coder.mjs`, `tests/agent-worktree.test.mjs` | ✅ (focused regression passes; full suite still has unrelated Windows-host failures) |
| P3-3 | OS-level isolation option | Optional container/namespace runner (network off by default) for untrusted repos | P3-1 | L | new; `docs/` | |

## Phase 4 — Agent family graph + UI

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P4-1 | Persistent agent family graph | Agents, families, parent/child edges, capability narrowing and budget reservation persisted in SQLite; survives restart; ports rules from `child-agents.mjs:71-101,229-266` | P1-1, P1-4 | L | new `src/platform/`; `src/agent/child-agents.mjs` | ✅ |
| P4-2 | Typed inter-agent messages | One vocabulary (`MESSAGE_TYPES`, contracts `:228`) replaces `child-agents.mjs:16`; messages persisted and scoped | P4-1 | M | `packages/atlas-contracts`, `src/agent/child-agents.mjs` | ✅ |
| P4-3 | Mission scheduler on family graph | `MissionScheduler` children become graph agents; existing mission tests still pass | P4-1 | M | `src/agent/mission-scheduler.mjs`, `mission-service.mjs` | |
| P4-5 | Business Development / Product executives and Innovation Backlog | BDE → Product Executive → specialists; peers commissioned by scoped cross-family requests; evidence-backed briefs, Opportunity Memory, council Decision Packets, digest-bound human approval, commissioning into platform tasks, measurement and lessons; wired into the daemon (`docs/atlas-os/INNOVATION.md`) | P4-1, P4-2, P1-1 | L | `src/platform/family/default-families.mjs`, new `src/platform/innovation/`, `src/server.mjs`, `src/main.mjs` | ✅ (`claude/atlas-platform-development-o9znpd`) |
| P4-4 | Family graph UI | Local UI and web show tree, status, budget per agent, live from outbox | P4-1, P1-1 | M | `src/ui.mjs`, `apps/web/app/automation/*` | |

## Phase 5 — Desktop

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P5-1 | Desktop control adapter (Windows UIA) | Screenshot, window list, focus, click/type via UI Automation; every action classified and approval-gated like browser actions | P1-3 | L | `apps/windows-companion/src/` (new module), `operator/classification.mjs` | |
| P5-2 | Desktop evidence + takeover | Before/after screenshots stored locally; operator can pause and take over | P5-1 | M | `apps/windows-companion/src/operator/session.mjs` | |

## Phase 6 — MCP, model router, Ollama, memory

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P6-1 | MCP gateway | Registers MCP servers' tools into the registry with declared risk/capability; every call passes policy engine + budget; server allowlist | P1-3, P1-4 | L | new `src/platform/`; `src/agent/tool-registry.mjs` | ✅ |
| P6-2 | Scoped memory store | Memories scoped by tenant/user/agent/task; writes audited; retrieval bounded; no cross-scope reads (tests) | P1-1 | M | new `src/platform/` | ✅ |
| P6-3 | Wire the model router | Conversation executor obtains its client via `router.run(task, …)`; fallback on non-auth errors | — | S | `src/main.mjs:115-120,237-240`, `src/agent/models/router.mjs` | |
| P6-4 | Ollama lifecycle | Health, pull-with-approval, context-fit enforcement surfaced in UI | P6-3 | M | `src/agent/models/*`, `apps/windows-companion/src/runtime.mjs` | |
| P6-5 | Registry secrets via vault | `ToolRegistry` resolves secrets from `credential-vault.mjs`, per-tool name allowlist (SEC-8) | — | S | `src/main.mjs:146`, `src/agent/credential-vault.mjs` | |

## Phase 7 — Verification, replay, recovery, scheduling

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P7-1 | Artifact verification records | Artifacts carry `unverified/verified/rejected` (contracts `:225`); coder verdict maps onto it | P1-1 | M | `scripts/runner/run-task.mjs`, `packages/atlas-cli/src/agent/verified-coder-session.ts` | |
| P7-2 | Deterministic replay from event log | Replay a task from outbox/events with recorded tool results; diff against original | P1-1 | L | `packages/atlas-cli/src/agent/session-replay.ts`, `src/platform/` | |
| P7-3 | Auto-merge requires passed verification | `none`/`ci-gated` merge only when `verification.status === "passed"`; policy resolved server-side (SEC-7) | — | S | `scripts/runner/create-coder-pull-request.mjs:187-214`, `merge-decision.mjs`, `atlas-coder.yml` | |
| P7-4 | Prompt-injection regression corpus | Fixture pages/repos with injected instructions; operator + conversation tests assert no gated action runs (SEC-11) | P1-3 | M | `apps/windows-companion/src/operator/scenarios.mjs`, `apps/local-control/tests/conversation.test.mjs` | |
| P7-5 | Time-based scheduler | Local cron-like schedules create tasks through intake + policy; Actions-minutes status surfaced (SEC-15) | P1-1 | M | new `src/platform/`; `scripts/runner/actions-budget.mjs` | |

## Phase 8 — Cortex construction (out of scope)

The owner confirmed Cortex belongs to a different repository, so no construction family, tools or bid workflow are built in Atlas. The default family seed no longer includes a Construction parent.

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P8-2 | Visual builder MVP | Build page produces a verified change set via the coder loop | P8-1 | L | `apps/web/app/build/*`, `packages/atlas-cli` | |

## Phase 9 — Multi-tenant hardening, marketplace, billing

| ID | Title | Acceptance criteria | Deps | Size | Touches | Branch |
|---|---|---|---|---|---|---|
| P9-1 | Tenant model | `tenants`, `memberships`; every owner-scoped table gains `tenant_id`; `repositories`/`installations` tenant-scoped; dispatch verifies the user's installation covers the repo (SEC-1) | P1-5 | L | `apps/web/db/schema.ts`, new migrations, `app/api/tasks/route.ts`, `dispatch.mjs`, `settings/repositories/route.ts` | |
| P9-2 | Per-tenant runner allowlist | Runner validates repo against signed dispatch claims instead of a hard-coded constant | P9-1 | M | `scripts/runner/validate-inputs.mjs:5,37`, `atlas-coder.yml` | |
| P9-3 | Usage metering on contracts budgets | Token/tool/time usage from P1-4 rolls up to `task_usage`/Stripe | P1-4, P9-1 | M | `app/api/billing/*`, `db/schema.ts` | |
| P9-4 | Web security headers | CSP, frame-ancestors, referrer policy on every response (SEC-13) | — | S | `apps/web/worker/index.ts` | |
| P9-5 | Connector/skill marketplace | Signed connector manifests, per-tenant install, policy defaults | P6-1, P9-1 | L | new | |
