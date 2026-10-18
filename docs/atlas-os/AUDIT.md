# Atlas OS — Phase 0 repository audit

## Current audit: 2026-10-08, main `2f44d0f`

This section supersedes the historical inventory below. It is a source and
boundary audit, not a completion percentage. `lc/` means
`apps/local-control/src/`; `web/` means `apps/web/`.
All requested root handoffs and `docs/{PROGRAM,ROADMAP,TODO-MAP,PROGRESS}.md`
were consulted. `PROGRAM.md` is actually `docs/PROGRAM.md`. Older handoffs
describe September deployments and do not establish the current runtime state.
The latest 30 main commits, 29 open PRs, recently merged PRs, open issues,
CI/deploy runs, and secret/variable names were inspected. No secret values
were retrieved. The operator's dirty checkout was preserved; this audit uses
an isolated worktree at the main revision above.

### A/B. Architecture and existing capabilities

| Subsystem | Actual status | Runtime wiring and evidence | Limit of the evidence |
|---|---|---|---|
| Hosted control plane | IMPLEMENTED AND VERIFIED | `web/worker/index.ts`, `web/app/api/{tasks,auth,setup}`, D1 `web/db/schema.ts`; main CI 37852481688 and deploy 37852481696 passed | Does not make local missions cloud-native |
| Hosted basic AI chat | IMPLEMENTED AND VERIFIED | `web/app/api/chat/{route.ts,agent-loop.mjs,providers.mjs}`; hosted run 37852689322 answered and persisted both modes: Groq non-streaming, Workers AI streaming | Basic reply success does not prove every multi-round tool workflow; #241 owns continuation repair |
| Inference governor | IMPLEMENTED AND VERIFIED | `packages/atlas-inference/src/*`, `web/worker/inference-governor*.mjs`, `web/app/api/inference/governor-client.mjs`, `web/vite.config.ts` migration `v1-inference-governor`; `inference-chaos`, `chat-governed-send`, package tests, main CI | Shared Worker quota scope; CLI/Actions model calls have no authenticated ledger path |
| Provider diversity | PARTIALLY IMPLEMENTED | Hosted Groq/OpenAI/Workers AI/self-hosted OpenAI-compatible routing; CLI `src/infrastructure/{groq,anthropic}-model-provider.ts`; local `lc/agent/models/{router,routed-client,manager}.mjs` | Anthropic is not a hosted-chat choice. Account existence is not live provider success. Workers AI native binding is still #233/#240 |
| Autonomous coder | IMPLEMENTED AND VERIFIED | `packages/atlas-cli/src/agent/verified-coder-session.ts`, `.github/workflows/atlas-coder.yml`, `scripts/runner/run-task.mjs`, `lc/runner.mjs`; CLI and runner CI, Genesis real coder/browser gate | CI uses scripted models for some journeys; current full hosted edit/test/PR recovery still needs a model-backed release journey |
| Local durable sessions/missions | IMPLEMENTED AND VERIFIED | `lc/agent/{runtime,session-store,mission-scheduler,mission-service}.mjs`; real SQLite restart/approval/cancel journey and `mission-throttle-recovery` tests | Restart restores interrupted work for explicit resume, not universal tool-level replay or automatic cloud migration |
| Unified kernel and Command Center | PARTIALLY IMPLEMENTED | `lc/agent/kernel/*`, team step executor, Genesis kernel traces, `lc/platform/command-center.mjs`, `/v1/command-center` UI | Hosted chat and CLI remain separate callers. A normalized local dashboard is not a durable hosted agent fleet |
| Automations and goals | IMPLEMENTED AND VERIFIED | `lc/platform/automations`, goals, main watcher/service wiring; automation/goal tests and main CI | The daemon must run; GitHub's scheduled coder is independently cloud hosted |
| Self-improvement | BROKEN at approval integrity boundary | `lc/platform/self-improve/{loop,service,runtime}.mjs`, main and server wiring; loop records head/base, service merges branch name | Branch movement after review can merge unreviewed changes. Raw coder/error logs also need a separate redaction slice |
| Genesis local app creation | IMPLEMENTED AND VERIFIED | `lc/platform/genesis/{service,executor,coder,preview,inspector,publish}.mjs`, shared auth/files/secrets/jobs/queue templates; main CI real Git/coder/Chromium/template journeys | Scripted model in CI; preview readiness is not production deployment verification |
| Genesis hosted/visual editing | PARTIALLY IMPLEMENTED | Hosted `web/app/api/genesis/projects/route.ts` persists planned requirements; #181 contains picker/source-mapped static text editing | Hosted route does not enqueue or run Genesis builds. No verified hosted visual editing/deploy lifecycle |
| Browser and computer control | PARTIALLY IMPLEMENTED | `apps/browser-worker/src/*`, Windows companion, hosted atomic claims/leases and action approvals; package tests and Windows CI | Local companion requires PC online. Takeover/re-observation work remains #237. Cloud executor deliberately unavailable |
| Free Local AI | PARTIALLY IMPLEMENTED | Main local model manager/Ollama/gateway; #230 guided setup, hardware registry, qualified coding probes | This PC's 0.6B model failed real coding repair; 1.7B requires more available RAM. Hosted per-user registration/revocation remains unfinished |
| Credentials/approvals | PARTIALLY IMPLEMENTED | OS-backed `lc/agent/credential-vault.mjs`, policy tools, hosted conditional one-time approval consumption, revocable identity/device sessions | Broker #233 and execution-boundary hardening #235 are not on main. Raw credentials must not be assumed capability-scoped everywhere |
| Replay/evaluation | PARTIALLY IMPLEMENTED | Existing coder/Genesis validation and benchmarks; #236 durable manifests/replay/eval release gate | Open PR and library tests are not a released end-to-end cloud replay capability |
| Knowledge graph/memory | PARTIALLY IMPLEMENTED | CLI repository maps, `lc/agent/kernel/{world-state,repo-graph}.mjs`, scoped family memory/team wiring and tests | Cross-organization graph is an initial slice; hosted memory UI remains #97 |
| MCP and skills | PARTIALLY IMPLEMENTED | `lc/platform/mcp/daemon-bridge.mjs` loaded from main; real stdio/HTTP policy tests | Signed skill libraries have no daemon construction or installation API; marketplace/gap-to-reviewed-install loop absent |
| Mobile | PARTIALLY IMPLEMENTED | Local pairing/revocation, mobile bridge/secure-storage helper tests, responsive hosted UI | `mobile/www/index.html` is a placeholder; bootstrap/push helpers lack production entry point. #61 needs physical-device validation |
| Billing/tenancy/retention | PARTIALLY IMPLEMENTED | Tenant-scoped D1 routes, session revocation, deletion and Stripe handlers with tests | Billing tokens are missing in repository metadata; hosted browser metering helpers are unwired. Atomic monthly cap is #203 |

### C. Disconnected or deliberately unavailable infrastructure

- `lc/platform/skills/*`: registry/proposals/signed packages/knowledge exchange
  are exported and unit-tested; no runtime construction outside that directory.
  Do not advertise installation or agent privilege expansion as shipped.
- `createHostedBrowserService` / `createCloudflareBrowserProvider`: test callers
  exist, no production executor claims hosted browser tasks.
  `web/app/api/computer/browser-plan.mjs` explicitly marks the executor unavailable
  and fails closed rather than queuing fictional work.
- `web/app/api/billing/hosted-usage.mjs`: metering helper is only called in tests;
  its allowance values differ from the actual route. Wiring requires one shared
  source of allowance truth and a real executor, not merely changing the flag.
- `mobile` bootstrap/push/deep-link helpers have tests but the native web entry
  does not load them. Local pairing is a separate, working capability.
- `src/atlas_agent` is the historical Python prototype, not the canonical runtime.
- Hosted Genesis requirements rows have no dispatcher into local or cloud Genesis.

### D. Open PR reconciliation

Green means the recorded head passed checks, not that it is deployed or current
against main. `UNKNOWN` mergeability is not a clean result. Preserve distinct
work and coordinate with owners before replacing it.

| PRs | Recommended disposition | Reason / required next gate |
|---|---|---|
| #129–#133, #158, #160 | Superseded in substance; close only after owner diff review | #224 ported contracts, ledger, circuits, registry, fingerprints and chat wiring while preserving newer main logic. Do not merge the historical loop again |
| #233 + stacked #240 | Repair/reconcile onto current main, protected review, deploy, live chat gate | #233 now conflicts; #240 CI green. Preserve #239 model choices and #241 continuation recovery. Native cancellation bounds waiting, not guaranteed physical compute cancellation |
| #241 | Released after independent review and all 13 CI checks | Merged as 17570ff; deploy 37858362540 passed. Hosted tool-chat gate 37858630572 passed both modes using Workers AI gpt-oss-120b, with answers stored and no early stop |
| #235 | Review after validation; remove draft when review-ready | All 13 CI jobs green. Complements broker rather than replacing it; protected credential/redaction/approval changes |
| #236 | Review/merge after integration validation | Replay/evaluation CI green; align capture at real runtime boundary and verify side-effect-free replay |
| #237 | Repair validation before merge | Windows local-control check is cancelled, not passed; require complete checks and takeover re-observation/crash journey |
| #230 | Keep draft, repair/rebase and finish runtime gates | Current head has only Vercel checks. Guided local qualification correctly rejects this PC's weak model; hosted tenant activation not finished |
| #223 | Review, rebase if needed, then merge after validation | Opportunity scout has green CI, but is lower priority than foundation/cloud blockers; earlier detailed review remains relevant |
| #207 | Rebase and review unique persistent-cache work | Main #205 provides request-scoped verified reuse, not necessarily this PR's cross-turn cache. Preserve tenant/principal/SHA isolation; #208 snapshot claim remains active |
| #191 | Reconcile, then supersede duplicated portions after review | Conflicts; #192/#193 fixed task storage and #239 preserves unsaved chat. Retain any distinct safe diagnostics |
| #200 | Repair failing CLI check, rebase | Adds local/health/billing behavior; current head's CLI check failed. Do not overwrite current retry/provider contracts |
| #202 | Reconcile conflict with kernel-era verifier | Keep untrusted tool logs as data; preserve any unique injection regression before closing |
| #203 | Rebase/validate and protected billing review | Atomic monthly limit fixes a real concurrent usage race; use real SQLite/conditional D1 tests |
| #181 | Rebase and verify scoped visual editor | Existing static text slice, not generic layout editing; do not create a second picker |
| #178 | Reconcile with #228/#232/#239 and #240 | Preserve distinct explicit provider selection in release gate, avoid duplicate smoke mechanisms |
| #61, #69, #77 | Rebase/repair; protected review where applicable | Mobile bootstrap, hosted rate limits, strict CSP. Old Vercel statuses do not validate current security/runtime boundaries |
| #97, #98, #101, #105 | Rebase and isolate remaining unique slices | Hosted memory, CI-aware tools, Genesis repo creation, default browser. Old drafts span changed entry points; do not blindly merge |

### E/F. Production blockers and PC-off operation

The PC can be off for hosted Worker chat and GitHub-managed coding. D1 task
history/result/activity are external and independent of a browser tab. Actions
provides ephemeral repository checkout/dependencies/filesystem/CLI execution,
logs and artifacts. This is reusable cloud execution, not a persistent cloud
desktop. Closing the client does not cancel an already-dispatched Actions run.

Local SQLite missions, automations, Genesis workers, Ollama and the Windows
companion stop when the host stops. There is no hosted worker consuming those
local stores, unified lease/checkpoint protocol across both planes, tenant-scoped
cloud browser executor, or cloud Genesis dispatcher. A phone controls existing
hosted routes; native helpers do not supply compute. No GPU fleet is necessary
for the first cloud slice: use the deployed hosted models and ephemeral workers.

Remaining inference gaps: CLI and hosted chat do not share quotas; main lacks
durable reconnectable chat jobs; chat HTTP disconnect is not propagated into
the model/tool loop. Existing response-body cancellation tests prove governor
release at that boundary, not at the browser request boundary. The native
adapter fixes in #240 do not by themselves close this outer disconnect gap.

GitHub secret names show chat/Groq/OpenAI/Workers AI/GitHub/OAuth/session/operator
and Cloudflare deployment settings present. Stripe and Anthropic are absent.
Presence is not validity or correct account scope. Hosted diagnosis in run
37852689322 reports Workers AI valid/permitted and HTTP 200 inference; basic
chat served by Groq and Workers AI. Worker runtime secrets are copied during
deployment, not read from GitHub at request time. No values were inspected.

### G. Prioritized implementation queue

| Priority / slice | Reuse and exact modules | Dependencies / acceptance / tests | Risk / owner intervention |
|---|---|---|---|
| P0 reviewed self-improvement source approval (selected now) | `lc/platform/self-improve/{service,loop}.mjs`, existing service tests and Git wrapper | Reproduce branch movement; reject stale head/base at preflight; merge immutable reviewed head without hooks; serialize approve/reject in the daemon; real Git and authenticated route tests | High integrity boundary; protected review before merge |
| P0 finish owned inference repairs | #233/#240/#241; `web/app/api/chat/*`, existing governor and smoke | Preserve main model menu; tool call→tool result→final answer both modes; safe failure category; queued/streaming disconnect cancellation and zero leaked reservations | High; owners coordinate overlapping loop/routes and binding review |
| P0 share runner quota admission | Existing governor DO and CLI retry/fallback; authenticated provider-neutral runner admission endpoint | #127 owner; short-lived scoped credential, bounded idempotent reservation/release; real concurrent runner+Worker test, no overspend | High protected auth; review and deployment needed |
| P0 self-improvement log redaction (separate slice) | Existing terminal redactor, service output/status boundary | Mask exact host/broker values before storage, chunk-split and error tests; preserve readable progress | High secrets boundary; coordinate #235 redactor and protected review |
| P1 first real cloud execution continuation | Actions executor, task D1/result/activity, local session/mission contracts | Durable checkpoint reference + lease heartbeat, idempotent retry/cancel, PC-off coding journey and crash without repeating consequential tools | High; tenant/credential review, no expensive GPU provisioning |
| P1 hosted browser execution | Existing browser provider/service/egress guard, task claims/approvals, billing helper | Scoped lease/session, shared quota truth, crash/cancel cleanup, remote takeover re-observe, real browser test with PC off | High; #105/#69/#237 coordination, configured browser service/budget |
| P1 broker and onboarding | #233/#235, vault/policy, repository setup and model choices | Capability-scoped adapters, wrong-account/revoke tests, ordinary-user account→repository→task→verified result | High protected; owner consent only for new scopes/checkpoints |
| P1 eval/replay release gate | #236, real traces and independent verifiers | No live side effects on replay; verified benchmark delta on routing/coding changes, rollback evidence | Medium/high; protected policy review |
| P2 Genesis visual/cloud build | #181, local Genesis executor/templates and hosted project rows | Single dispatcher to approved executor, preview source map/edit/retest/deploy health, preserve independent checks | High deployments; scope and deployment credentials approved |
| P2 mobile/skills integration | #61/#237, paired devices, signed skills registry, MCP policy | Physical-device approval resume; installed signed skill visible only after digest-bound authorization; revoke and no self-grant | High privileges; human checkpoints retained |

### H. Immediate slice

The chosen unclaimed repair is exact-revision self-improvement approval. It
uses the current loop's accepted `head`/`base` evidence and the existing owner
API; no new executor, broker or TODO is introduced. Real Git regressions failed before the repair: moved source/base approvals did
not reject, repository hooks executed, and inherited signing broke approval.
The service now merges the immutable accepted commit, rejects stale source/base
and missing revision evidence, serializes decisions within the daemon, uses the
existing hook-free Git commit configuration, and compare-deletes branch refs.
The existing owner API returns actionable HTTP 409 errors and persists reviewed
head/base receipts. No new approval system or UI is introduced.

Validation: all 21 affected service/loop tests passed; the full local-control
suite exited successfully; the real HTTP/SQLite journey passed approval, deny,
pause/resume/cancel, process restart and persisted mission recovery. Regression
coverage includes authenticated daemon requests, device denial, one-time
decisions, durable receipts, moved branches, hooks and signing configuration.
Syntax checks and diff whitespace validation passed. PR #243 contains this repair. Protected review remains
the release boundary.

The repair is scoped to one daemon's approval path. It is not a cross-process
transaction over an operator's Git checkout: external checkout/commit activity
can race the destination preflight. A crash after Git merges but before the
decision receipt persists fails closed on the changed base at retry, rather
than replaying the merge, but still needs manual reconciliation of the receipt.
Durable cross-process approval leases and atomic destination compare-and-swap
belong in the existing task/approval architecture in a subsequent slice.

## Historical audit: 2026-09-24

The rest of this file is historical evidence, not current runtime claims.
In particular its old statements about no Durable Objects, no desktop control,
and absent automations are superseded by the current inventory above.

Audit date: 2026-09-24. Branch `claude/atlas-implementation-eah694`, base commit
`4ce465e` ("Add versioned dependency-free Atlas platform contracts").

Every row below cites files that were opened and read for this audit. Status
vocabulary:

| Status | Meaning |
|---|---|
| **implemented+tested** | Code exists, is wired into a running entry point, and a test under `*/tests/` exercises it |
| **implemented-untested** | Code exists and is wired, no test found that exercises it |
| **partial** | Some of the capability exists (library-only, not wired, one platform, or a narrower scope than the blueprint) |
| **missing** | No code found |
| **in progress on this branch** | Being built by a sibling agent on this branch; not counted as existing |

Paths are relative to the repository root. `lc/` = `apps/local-control/src/`,
`web/` = `apps/web/`, `wc/` = `apps/windows-companion/src/`, `cli/` =
`packages/atlas-cli/src/`.

---

## Component inventory (what actually exists)

| Component | Runtime | Persistence | Tests | Entry point |
|---|---|---|---|---|
| `apps/web` | Cloudflare Worker (vinext, `web/worker/index.ts`), deployed by `.github/workflows/deploy-cloudflare.yml:39` | D1 via Drizzle (`web/db/schema.ts`, 13 migrations `web/drizzle/0000…0012`) | 19 files, ~127 tests (`web/tests/`) | `web/worker/index.ts` |
| `apps/local-control` | Node ≥22.13 daemon, zero npm deps (`apps/local-control/package.json`) | `node:sqlite` WAL files `atlas.sqlite` (`lc/store.mjs:12`) and `agent.sqlite` (`lc/agent/session-store.mjs:21`) | 18 files, ~172 tests | `lc/main.mjs` (binds `127.0.0.1:4317`, `lc/main.mjs:76-78`) |
| `apps/windows-companion` | Node + `playwright-core@1.55.0`, launches Edge (`wc/index.mjs:18`) | none (polls web D1) | 4 files, 22 tests | `wc/index.mjs` |
| `packages/atlas-cli` | Strict TS CLI, zero runtime deps | JSON-Lines audit (`cli/infrastructure/json-lines-session-audit-store.ts`) | ~62 test files (`packages/atlas-cli/tests/`) | `cli/cli.ts` |
| `packages/atlas-contracts` | Dependency-free ESM (`packages/atlas-contracts/src/index.mjs`, 459 lines) | none | 1 file, 6 tests; not in `ci.yml` at base (added on this branch, `ef5fc08`) | library |
| `scripts/runner` | GitHub Actions job scripts | Actions artifacts | 5 test files (`scripts/runner/*.test.mjs`) | `.github/workflows/atlas-coder.yml`, `atlas-runner.yml` |
| `scripts/local` | Local coder launcher / model gateway | worktrees + patches in data dir | `model-gateway.test.mjs` | `scripts/local/run-coder.mjs` |
| `mobile/` | Capacitor shell (`mobile/capacitor.config.json`) | secure storage bridge (`mobile/src/secure-storage.mjs`) | `mobile/tests/shell.test.mjs` | `mobile/www` |
| `src/atlas_agent` | Legacy Python prototype, not integrated (README.md "Legacy Python prototype") | — | `tests/test_agent.py` | — |

---

## 1. Planes (control / execution / data / integration)

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Hosted control plane (intake, auth, billing, task history) | implemented+tested | `web/app/api/tasks/route.ts`, `web/app/api/auth/*`, `web/app/api/billing/*`; tests `web/tests/dispatch.test.mjs`, `operator-auth.test.mjs`, `billing-lifecycle.test.mjs` | Request/response only; delegates execution to GitHub Actions or `ATLAS_AGENT_DISPATCH_URL` (`route.ts:62-90`) |
| Local control plane (tasks, policies, approvals, devices, audit) | implemented+tested | `lc/server.mjs`, `lc/store.mjs`; `apps/local-control/tests/local-control.test.mjs`, `agent-http.test.mjs` | Single-owner; admin token + paired device tokens (`lc/server.mjs:122-127`) |
| Execution plane: GitHub Actions runners | implemented+tested | `.github/workflows/atlas-coder.yml`, `atlas-runner.yml`, `scripts/runner/run-task.mjs`; `scripts/runner/*.test.mjs` | Coder runner hard-allowlists one repo (`scripts/runner/validate-inputs.mjs:5,37`) |
| Execution plane: local daemon executors | implemented+tested | `lc/agent/executors.mjs:28,99`, `lc/agent/conversation-executor.mjs`; `agent-runtime.test.mjs` | `local`, `conversation`, optional `github-actions` (`lc/main.mjs:115-137`) |
| Execution plane: Windows companion (browser) | implemented+tested | `wc/index.mjs`, `wc/operator/session.mjs`; `apps/windows-companion/tests/operator.test.mjs` | Leases `computer_tasks` from web via `web/app/api/computer/companion/poll/route.ts` |
| Data plane: hosted | implemented+tested | D1 schema `web/db/schema.ts` (17 tables), `web/tests/repository-schema.test.mjs` | No R2 (`web/.openai/hosting.json` `"r2": null`), no Queues/Durable Objects bindings |
| Data plane: local | implemented+tested | `lc/store.mjs:14-63`, `lc/agent/session-store.mjs:22-62` | Two separate SQLite files; no shared transaction |
| Integration plane (GitHub, Cloudflare, Vercel, git hosts) | implemented+tested | `lc/agent/infrastructure/{adapter,cloudflare,vercel,git-hosts}.mjs`; `infrastructure.test.mjs`; `web/app/api/tasks/github-app.mjs`, `github-app.test.mjs` | Adapter per vendor; no connector framework |
| Shared versioned contracts between planes | partial | `packages/atlas-contracts/src/index.mjs` (schemas, ids, digests, task FSM); `packages/atlas-contracts/tests/contracts.test.mjs` | Library only — **no app imports it yet** (grep of `apps/`, `scripts/` finds no import). Budget dimension `wallTimeMs` (`index.mjs:249`) differs from local `elapsedMs` (`lc/agent/budget.mjs:7`) |

## 2. Durable queue and event stream

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Durable per-session event log with gap-free sequence | implemented+tested | `lc/agent/session-store.mjs:42-49,129-140` (BEGIN IMMEDIATE sequence allocation); `agent-runtime.test.mjs:97,135` | Replay from cursor supported |
| Append-only mission events (DB-enforced) | implemented+tested | `lc/store.mjs:42-53` (UPDATE/DELETE triggers raise); `mission-store.test.mjs` | Only table with DB-level immutability |
| Session leases + boot recovery | implemented+tested | `lc/agent/session-store.mjs` `acquireLease/renewLease/staleRunningSessions`; `lc/agent/runtime.mjs:77-91`; tests `agent-runtime.test.mjs:281,306` | Lease 30 s, heartbeat 10 s (`runtime.mjs:7-8`) |
| Hosted work queue with leases | implemented+tested (partial scope) | `computer_tasks.leaseExpiresAt/attemptCount` (`web/db/schema.ts`); claim/recover in `web/app/api/computer/companion/poll/route.ts:15-27` | Browser tasks only; no test directly covers the poll route SQL |
| Generic durable task queue (typed tasks/steps, retries, DLQ) | missing → **in progress on this branch** | none today; planned `lc/platform/` durable task store | Coder tasks live only as GitHub Actions runs + `tasks` rows |
| Transactional outbox / event fan-out | missing → **in progress on this branch** | none today | Local runtime emits to in-memory listeners (`runtime.mjs` `#listeners`) |
| Cross-component correlation id | missing → **in progress on this branch** | helpers exist in `packages/atlas-contracts/src/index.mjs:58-70`; grep for `correlation` in `apps/web/app`, `lc/`, `scripts/` returns nothing | web→Actions uses `task_id` + `run-name` (`atlas-coder.yml:7`) instead |
| Hosted run results ingestion (signed) | implemented+tested | `web/app/api/tasks/result/route.ts` (GitHub OIDC, `runner-result.mjs:6-17`); `runner-result.test.mjs` | Idempotent via stable ids + `onConflictDoNothing` (`result/route.ts:43-50`) |

## 3. Agent family graph

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Parent/child agent tree with depth/fanout limits | partial | `lc/agent/child-agents.mjs:186-266` (`ChildAgentRegistry`); `child-agents.test.mjs` (9 tests) | **In-memory `Map` only** (`child-agents.mjs:187-188`); not imported by any `src/` module — test-only |
| Capability narrowing (child ⊆ parent) | implemented+tested (library) | `child-agents.mjs:71-99` (`assertSubset`, `CAPABILITY_ESCALATION`) | Same caveat: not wired |
| Budget reservation parent→child | implemented+tested (library) | `child-agents.mjs:97-101,262,377-381` | Same caveat |
| Mission DAG scheduler (parallel children, deps, concurrency) | implemented+tested | `lc/agent/mission-scheduler.mjs:36-105`, `lc/agent/mission-service.mjs`; routes `lc/agent/mission-routes.mjs`; `mission-scheduler.test.mjs`, `mission-service.test.mjs`, `mission-http.test.mjs` | Wired in `lc/main.mjs:61-63`; children are isolated local coder runs (`main.mjs:80-97`) |
| Persistent family graph, families/roles, cross-family requests | missing → **in progress on this branch** | planned `lc/platform/` agent family graph | Contract shapes exist: `agentSchema` (`atlas-contracts/src/index.mjs:289`), `MESSAGE_TYPES` (`:228`) |
| UI for family graph | missing | — | Mission UI exists (`mission-ui.test.mjs`) but no graph view |

## 4. Lifecycle and typed messages

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Normalized agent event kinds (fail-closed) | implemented+tested | `lc/agent/events.mjs`; `agent-runtime.test.mjs:74` | Session-level, not task/step-level |
| Session lifecycle (idle/queued/running/paused/interrupted/…) | implemented+tested | `lc/agent/runtime.mjs:16`, `lc/agent/run-control.mjs`; tests `:165,185,204,257` | |
| Blueprint task FSM (proposed→authorized→queued→…→archived) | partial | `atlas-contracts/src/index.mjs:194-219`; `contracts.test.mjs` | Not used by any runtime |
| Typed inter-agent messages | partial | `child-agents.mjs:16` (`instruction/context/question/answer/status`, scoped to parent/child/sibling `:282`); `MESSAGE_TYPES` in contracts `:228` | Two vocabularies; neither persisted |
| Hosted task status | implemented+tested | `web/app/api/tasks/run-status.mjs`; `run-status.test.mjs` (21 tests) | Derived from GitHub run state; heuristic match for legacy runs (HANDOFF.md §9) |

## 5. Browser automation

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Playwright page adapter (local daemon) | implemented+tested | `lc/agent/browser/playwright-page.mjs` (dynamic `import("playwright-core")`, `:27-33`); `tool-families.test.mjs:364-391` | Fails closed when Playwright absent; persistent profile, not disposable |
| Browser tool family (navigate/snapshot/click/type/submit/upload/download/extract) | implemented+tested | `lc/agent/tools/browser-tools.mjs:61-240`; `tool-families.test.mjs:193,246` | Submit/upload approval-gated |
| Deterministic action classification + approval gate + evidence | implemented+tested | `wc/operator/classification.mjs:10,105`, `wc/operator/session.mjs:86-115`; `operator.test.mjs` | Reused by daemon via cross-package import `lc/main.mjs:177` |
| Windows companion hosted-task loop | implemented+tested (policy/runtime units) | `wc/index.mjs`, `wc/policy.mjs`, `wc/runtime.mjs`; `policy.test.mjs`, `runtime.test.mjs` | `index.mjs` main loop itself untested |
| Cloudflare Browser Rendering provider | implemented-untested against real API | `lc/agent/browser/cloudflare-browser.mjs`; unit test with fake fetch `hosted-browser.test.mjs:193` | Calls `/goto`, `/click`, `/type`, `/press` sub-paths (`:49-52`) — Browser Rendering's REST API is stateless (content/snapshot/screenshot/…); these endpoints are unverified. **Not wired** into `lc/main.mjs` |
| Hosted browser tenant isolation + quota | implemented+tested (library) | `lc/agent/browser/hosted-browser.mjs:25-40`, `quota.mjs`; `hosted-browser.test.mjs` | In-memory session map; not wired |
| Hosted browser from web UI | partial (dead end) | `web/app/api/computer/tasks/route.ts:52-58` creates a synthetic `cloudflare-…` device and queues a task | **No consumer exists**: the synthetic device secret is random and discarded, so nothing can poll it; tasks queue forever |
| Disposable Chromium worker package | missing → **in progress on this branch** | planned `apps/browser-worker/` | |
| SSRF / private-network URL controls | missing | `browser-tools.mjs:28-39` checks scheme only; `computer/tasks/route.ts:47-49` scheme only | See SECURITY-REVIEW |

## 6. Desktop control

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| OS-level desktop control (mouse/keyboard/UIA/screenshots of desktop) | missing | grep for `UIAutomation|robotjs|nut-js|SendKeys|xdotool|pyautogui` in `apps/ scripts/ src/` returns nothing | "Computer" in this repo means browser-in-Edge only (`wc/index.mjs:18`) |
| Windows packaging / supervised start | implemented-untested (CI runs requirement report + manifest verify) | `scripts/windows/*.ps1`, `scripts/windows/Start-AtlasSupervised.mjs`, `lc/release/supervisor.mjs`; `release.test.mjs`; `ci.yml:153-184` | |
| Device pairing + revocation | implemented+tested | local: `lc/server.mjs:39-51,99-102`; hosted: `web/app/api/computer/devices/*`, `companion-auth.ts` | Hosted device secret stored as SHA-256 (`schema.ts computerDevices.secretHash`) |

## 7. Terminal execution

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| No-shell, bounded, env-allowlisted subprocess | implemented+tested | `lc/agent/tools/process.mjs:11-73`; `tool-families.test.mjs:136`; CLI `cli/domain/safe-command-runner.ts`, `cli/infrastructure/bounded-command-runner.ts` + tests | |
| Fixed allowlisted verification commands (approval-gated) | implemented+tested | `lc/agent/tools/repository-write-tools.mjs:173-196` (`repository.run_tests`, `requiresApproval: true`); `tool-families.test.mjs:117` | Only enumerated commands; no free-form terminal |
| General interactive terminal / PTY sessions | missing → **in progress on this branch** (sandbox controller) | — | |
| OS/container sandbox (namespaces, seccomp, network off) | missing | worktree isolation only (`lc/runner.mjs:43-52`) | Local coder child inherits full env: `lc/runner.mjs:15` passes no `env`; `scripts/local/run-coder.mjs:84` spreads `process.env` |
| GitHub-hosted runner as sandbox | implemented | `atlas-coder.yml` (`permissions: contents: read` at `:47-48,69-70`; target branch checked out "as untrusted data" `:103`) | Ephemeral VM per run |

## 8. Autonomous software engineering

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Verified coder loop (baseline → edit → re-verify → repair → verdict) | implemented+tested | `cli/agent/verified-coder-session.ts`, `cli/agent/verification-planning.ts`; `verified-coder-session.test.ts`, `verification-planning.test.ts` | Core product loop (HANDOFF.md §1) |
| Transactional multi-file change sets + approval | implemented+tested | `cli/infrastructure/transactional-repository-change-set-editor.ts`, `cli/domain/change-set-approval.ts`, `cli/infrastructure/in-memory-change-set-approval-store.ts`; matching tests | In-memory approval store |
| PR creation + merge policy (manual/ci-gated/none) | implemented+tested | `scripts/runner/create-coder-pull-request.mjs:145-214`, `merge-decision.mjs`; `merge-decision.test.mjs` | Regression blocks auto-merge (`create-coder-pull-request.mjs:187`) |
| Self-improvement schedule | implemented-untested (workflow) | `.github/workflows/atlas-self-improve.yml:27-39`, `.github/atlas/build-dispatch.py:36` (merge policy hard-coded `manual`) | Validated by `.github/atlas/check-workflows.py` only |
| Actions-minutes budget guard | implemented+tested | `scripts/runner/actions-budget.mjs` (UNKNOWN blocks by default; explicit allow policy); `actions-budget.test.mjs` | |
| Local isolated worktree coder + portable patch | implemented+tested | `lc/runner.mjs:39-72`; `agent-worktree.test.mjs` | |
| Multi-repo hosted coder | partial | web allowlist `ATLAS_ALLOWED_REPOSITORIES` (`route.ts:25`) but runner hard-allows only `cornerstonemarketingus/atlas` (`validate-inputs.mjs:5,37`) | Effectively single-repository |

## 9. MCP / connectors

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| MCP client or server | missing → **in progress on this branch** (MCP gateway) | grep `mcp` / "model context protocol" over `apps packages scripts src` returns nothing | |
| Vendor adapters (Cloudflare, Vercel, GitHub/GitLab/Forgejo) | implemented+tested | `lc/agent/infrastructure/*.mjs`, `lc/publish-adapters.mjs`; `infrastructure.test.mjs` | Plan/apply/rollback, apply approval-gated (`infrastructure-tools.mjs:87`) |
| Credential vault (by-reference secrets) | implemented+tested | `lc/agent/credential-vault.mjs` (DPAPI/Keychain/libsecret, scrypt+AES-GCM fallback); `tool-registry.mjs:11-16` | Registry secrets currently resolve from `process.env` (`lc/main.mjs:146`), not the vault |
| Communications (draft→approve→send) | implemented+tested, send disabled | `lc/agent/tools/communications-tools.mjs`; `tool-families.test.mjs:254,295` | Wired with `send: null` (`lc/main.mjs:152`) |

## 10. Model router and local AI (Ollama)

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| OpenAI-compatible model client (Ollama/vLLM/LM Studio) | implemented+tested | `lc/agent/model-client.mjs`; `conversation.test.mjs` | |
| Task-based router with fallback | partial | `lc/agent/models/router.mjs:17-37`; `models.test.mjs:148-178` | **Only `describeRoutes` is used** (`lc/main.mjs:238-261`); conversation executor uses a single client (`main.mjs:118-119`) |
| Hardware detection, model discovery, recommendation, context fit | implemented+tested | `lc/agent/models/{hardware,discovery,recommend,context-fit,evaluations}.mjs`; `models.test.mjs` | |
| Hosted chat endpoint validation (HTTPS/loopback, no creds in URL) | implemented+tested | `web/app/api/chat/model-endpoint.mjs:28-58`; `chat-model-endpoint.test.mjs` | |
| CLI providers: Groq, Anthropic, local, fallback, retry, budgeted, redacting | implemented+tested | `cli/infrastructure/*-model-provider.ts`; matching tests | |
| Self-hosted model on Actions runner | implemented-untested | `atlas-coder.yml:138` (start model server), timeout 330 min `:64`; LOCAL-MODEL.md §B | |
| Companion uses local Ollama | implemented-untested | `wc/index.mjs:11-12` | |

## 11. Memory

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Conversation compaction | implemented+tested | `lc/agent/compaction.mjs`; `conversation.test.mjs` | Context-window management, not memory |
| Scoped long-term memory store (user/tenant/agent/task scope) | missing → **in progress on this branch** | grep for memory/vector/embedding in `lc/`, `cli/` finds only a redactor pattern | |
| Local profile facts for companion prompts | partial | `wc/profile.mjs`; `profile.test.mjs` | Env-supplied JSON, read-only |

## 12. Planning and scheduling

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Read-only planning agent | implemented+tested | `cli/agent/read-only-planning-agent.ts`, `provider-read-only-planning-agent.ts`; tests | |
| DAG mission planning (acyclic, explicit deps) | implemented+tested | `lc/agent/mission-scheduler.mjs:36-89` | |
| Time-based scheduling (cron) | partial | GitHub cron only (`atlas-self-improve.yml:37-38`); `web` has no Cron Triggers (`web/worker/index.ts` exports `fetch` only) | No local scheduler |
| Workflow briefs (prepare, never submit) | implemented+tested | `lc/agent/tools/workflow-tools.mjs`; `tool-families.test.mjs:304` | |

## 13. Verification and recovery

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Baseline/post-change validation comparator | implemented+tested | `cli/domain/validation-comparator.ts`, `cli/infrastructure/validation-profile-runner.ts`; tests | |
| Session replay (reconstruct from trace) | implemented+tested (read-only reconstruction) | `cli/agent/session-replay.ts`, `cli/cli-replay.ts`; `session-replay.test.ts`; REPLAY.md | Digests not content → cannot re-execute (REPLAY.md "What it can and cannot show") |
| Runtime restart recovery | implemented+tested | `runtime.mjs:77-91`, `mission-service.mjs:39`; `agent-runtime.test.mjs:281` | Missions require operator resume (`main.mjs:62`) |
| Hosted browser lease recovery | implemented-untested | `companion/poll/route.ts:15-21` | |
| Artifact verification state | partial | `ARTIFACT_VERIFICATION` in contracts `:225` | Not used by runtimes |
| Deterministic replay / re-execution | missing | — | |

## 14. Construction / Cortex

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| "Cortex" construction subsystem | out of scope | — | Owner decision: Cortex belongs to a different repository and is not built here |
| Visual app builder | missing (roadmap only) | `docs/OPERATOR-QUALITY-ROADMAP.md` §8 | |
| Build page (task composer for coder mode) | implemented-untested | `web/app/build/BuildSection.tsx`, `web/app/build/task-presentation.mjs` | UI over `/api/tasks` |

## 15. Security and tenancy

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Tenant model | partial | No `tenants`/`orgs` table in `web/db/schema.ts`; isolation keyed on principal string `requested_by` (`schema.ts` tasks comment; `route.ts:163-175`) | One user = one tenant; `repositories` and `installations` are global |
| Secret redaction (5 boundaries) | implemented+tested | `cli/infrastructure/pattern-secret-redactor.ts`, `redacting-model-provider.ts`, `cli-redact.ts`; tests incl. `cli-redaction-e2e.test.ts` | Pattern-based (HANDOFF.md §9) |
| Local tool policy allow/ask/deny, default deny | implemented+tested | `lc/agent/tool-registry.mjs:125-205`, `lc/store.mjs` `policy()`; `tool-families.test.mjs` | |
| Digest-bound one-time approvals | implemented+tested | local `tool-registry.mjs:95` + `store.consumeApprovedDigest`; hosted `companion/approval/[id]/route.ts:20-23` | Hosted consume has a race — see SECURITY-REVIEW |
| Deterministic policy engine / authorized executor | missing → **in progress on this branch** | — | |
| Self-protection of Atlas repo | implemented+tested | `web/app/api/tasks/self-protection.mjs`; `self-protection.test.mjs` | |

## 16. Dashboard

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Hosted web shell (chat, build, computer, automation, setup, account) | implemented-untested (render smoke test) | `web/app/*/page.tsx`; `rendered-html.test.mjs` (6 tests) | |
| Setup readiness | implemented-untested | `web/app/api/setup/status/route.ts` | |
| Local daemon UI | implemented+tested | `lc/ui.mjs`; `mission-ui.test.mjs` | Strict CSP (`lc/server.mjs:30`) |
| Mobile approval shell | partial | `mobile/src/*.mjs`, `lc/mobile/*.mjs`; `mobile.test.mjs`, `mobile/tests/shell.test.mjs` | Native signing not done (SOVEREIGN-MODE.md "Remaining product work") |
| Family graph / cost / live event dashboards | missing | — | |

## 17. Data model

| Entity (blueprint) | Hosted (D1) | Local (SQLite) | Contract |
|---|---|---|---|
| Tenant | missing (principal string only) | missing (single owner) | `tenantId` required in `taskSchema` (`contracts:267`) |
| User | `users` | owner + `local_devices` | `actorSchema` |
| Task | `tasks`, `computer_tasks` | `local_tasks`, `agent_sessions`, `local_missions` | `taskSchema` |
| Step / tool call | missing | `agent_events` (as events) | `toolCallSchema` |
| Approval | `computer_approvals` | `local_approvals` (+`action_digest`) | `APPROVAL_STATES` |
| Event / audit | `run_events`, `computer_task_events`, `account_deletion_requests` | `local_audit`, `agent_events`, `local_mission_events` | `eventSchema` |
| Agent | missing | missing (in-memory registry) | `agentSchema` |
| Artifact | Actions artifacts only | patch files in data dir | `artifactSchema` |
| Budget / usage | `task_usage`, `hosted_browser_usage` | `agent_sessions.budget_json/usage_json` | `budgetSchema` |
| Billing | `subscriptions`, `billing_events` | offline license (`lc/offline-license.mjs`) | — |

## 18. API contracts

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Hosted REST API | implemented+tested (validation units) | `web/app/api/**/route.ts` (≈30 routes) | No OpenAPI / versioning; hand-written validators |
| Local REST API `/v1/*` | implemented+tested | `lc/server.mjs`, `lc/agent/routes.mjs`, `lc/agent/mission-routes.mjs`; `docs/agent-runtime.md` "HTTP surface" | Path-versioned `/v1` |
| Runner → web result contract (OIDC-signed) | implemented+tested | `web/app/api/tasks/runner-result.mjs`; `scripts/runner/report-result.mjs` | |
| Versioned JSON schemas (`schemaVersion: atlas.v1`) | partial | `packages/atlas-contracts/src/index.mjs:15,264-445` | Not yet consumed |

## 19. Operations / CI

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| CI for cli, web, local-control, companion, mobile, release tooling, runner scripts, workflow syntax | implemented | `.github/workflows/ci.yml:27-215` | `packages/atlas-contracts` not in CI at base commit `4ce465e`; added on this branch by commit `ef5fc08` |
| Deploy + secret upload | implemented | `.github/workflows/deploy-cloudflare.yml` | No top-level `permissions:` block |
| D1 migrate/provision | implemented | `migrate-d1.yml`, `provision-d1.yml` | Dispatch-only |
| Signed release manifest, SBOM, downgrade refusal | implemented+tested | `scripts/release/*.mjs`, `lc/release/*.mjs`; `release.test.mjs` | |

---

## Runtime constraints

| Host | Can host | Cannot host | Evidence |
|---|---|---|---|
| **Cloudflare Worker (`apps/web`)** | Short request/response handlers; D1 reads/writes; outbound `fetch` to GitHub/Stripe/model endpoints with 10 s timeouts (`dispatch.mjs:66`, `result/route.ts:33`); OIDC verification (`jose`) | Playwright/Chromium (no process spawning, no filesystem, no native binaries); long-running jobs inside a request (CPU-time limited per request; no `waitUntil`-based job loop exists); persistent sockets to workers; terminal sessions | Entry exports only `fetch` (`web/worker/index.ts:28-45`); bindings are `ASSETS`, `DB`, `IMAGES` only (`worker/index.ts:5-15`, `.openai/hosting.json`) — **no Browser Rendering binding, no Queues, no Durable Objects, no Cron Triggers, no Workflows** |
| **Cloudflare Browser Rendering** | Could provide hosted Chromium for the web plane via REST or a `browser` binding | Currently not bound to the Worker; only a local-daemon REST adapter exists (`lc/agent/browser/cloudflare-browser.mjs`) and is not wired (`lc/main.mjs` never imports it). Its stateful `/goto`/`/click` paths are unverified | `cloudflare-browser.mjs:14-52`; `web/app/api/computer/tasks/route.ts:52-58` queues hosted tasks with no consumer |
| **`apps/local-control` daemon** | Long-lived runtime with leases/recovery; SQLite durable state; subprocesses (git, tests, local coder); optional Playwright via dynamic import; local model servers (Ollama) | Multi-tenant hosting (single owner token, binds `127.0.0.1` by default `main.mjs:76`); OS sandboxing (no container/namespace isolation) | `lc/main.mjs`, `lc/agent/runtime.mjs`, `lc/agent/tools/process.mjs` |
| **`apps/windows-companion`** | Headed Edge browser automation on the user's PC, local Ollama | Headless fleet; desktop (non-browser) control | `wc/index.mjs:9-19` |
| **GitHub Actions runners** | Ephemeral VM per coder/inspect run: build, tests, model calls, PR creation; up to 25 min hosted-API / 330 min self-hosted-model (`atlas-coder.yml:64`) | Interactive/long-lived sessions; low-latency browser control; guaranteed start latency; per-run cost ceiling beyond the Actions-minutes guard (UNKNOWN blocks by default; explicitly overridable) | `.github/workflows/atlas-coder.yml`, `atlas-runner.yml` |
| **`apps/browser-worker`** (in progress on this branch) | Disposable Playwright/Chromium sessions as a separate Node package so `local-control` stays dependency-free | — | planned |

**Conclusion:** the web Worker must remain an orchestrator (intake, authz, queue
rows, status, approvals). All long-lived browser, desktop and terminal work must
run on the local daemon, the companion, the browser-worker, or an Actions
runner. Adding hosted execution on Cloudflare would require new bindings
(Browser Rendering, Queues/Durable Objects/Workflows) that do not exist today.
