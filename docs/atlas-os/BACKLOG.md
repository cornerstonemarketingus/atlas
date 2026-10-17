# Atlas implementation backlog — evidence refresh 2026-10-15

The owner's current order is: audit first, reliability, Genesis, persistent
cloud execution, browser control, collaboration, business workflows, customer
release. [ARCHITECTURE.md](ARCHITECTURE.md) separates source, runtime wiring,
automated coverage, real sessions and deployed evidence. Historical rows below
are retained for traceability and are superseded by this queue. No duplicate
TODO is introduced. Check current ownership before each implementation.

## Reliability slice — CLI retry cancellation (#305, 2026-10-17)

The existing `RetryingModelProvider` is instantiated by the CLI's actual
provider routes. Cancellation previously could still invoke a provider before
the first attempt or after a resolving backoff, report a last-attempt rate
failure instead of cancellation, or accept late success from an abort-ignoring
adapter. Successful default backoffs also retained their abort listener.

The focused change checks cancellation before dispatch, after completion and
before handling provider failures; cancelled requests use the existing
nonretryable `cancelled` error. Timer and abort paths remove their listener.
Five new regressions fail against the original wrapper and pass with the fix;
the real loopback HTTP fixture confirms exactly one request when cancellation
occurs during backoff. Focused retry/fallback/timing validation passes 21/21;
TypeScript build passes. Refreshed full Windows suite: 533 tests, 525 pass,
four skips and four failures. Those Windows failures reproduce with
the unmodified retry wrapper (CRLF, doubled drive path, and two POSIX-mode
assertions). Remote CI status belongs to the focused PR.

No provider, fallback configuration, credential, approval or shared quota
implementation was replaced. The wrapper prevents subsequent dispatch and late
success; it cannot forcibly stop an adapter that ignores AbortSignal or undo
provider charges. Cross-runtime quota settlement remains in the queue. Active
PROGRESS and provider documentation edits are preserved; #305 carries the
handoff until integration.

| Priority / task | Reuse and exact scope | Dependencies / ownership | Acceptance and required tests | Risk / owner intervention |
|---|---|---|---|---|
| P0: finish evidence audit | Existing ARCHITECTURE.md and this backlog; audited main b47f136, later-main delta reviewed separately | #279; preserve all active implementation PRs | Fresh suites, daemon HTTP restart/approval journey, exact-commit CI failure and hosted acceptance; document unavailable visual/native tests | Low; no runtime deployment |
| P1: intermittent Windows boot diagnosis | `apps/local-control/tests/daemon-boot.test.mjs`, `src/main.mjs`, health/startup path | Coordinate build-reliability #165; current main CI 38834441308 passes Windows | Explain historical CI 38160397827's 15-second empty-output health timeout; reproduce or improve bounded diagnostics without concealing failure; actual Windows boot and affected suite | Medium; owner review only if protected startup policy or CI changes |
| P0: untrusted coder isolation | Existing #253 runner validation/workflow changes; `scripts/runner/run-task.mjs` | #245 ownership; security/workflow review | Generated package scripts cannot access trusted publisher credentials or alter publisher; adversarial process/container test; timeout/cancel cleanup; no unrestricted-host fallback | High; protected owner review; no paid provisioning |
| P0: credential and approval boundaries | #233/#235, vault, registry, authorized executor and broker | #234; reconcile overlap, preserve security policy | Scope and resolve credentials at execution, bind identity/task/environment/action/digest/expiry; revoke/cancel tests; zero credential values in prompts/audit/tool outputs; actual daemon transport tests | High; owner security review; configured credentials for live qualification |
| P0: durable dispatch and action fencing | #270/#274/#276/#278/#282; D1 task intent/request identity, runner execution claims and result ownership | Existing claims, migrations, worker identity; compose with #266; #284 Genesis receipt recovery | Lost browser response or GitHub acknowledgement creates one logical task; duplicate/stale attempts cannot mutate/publish; crash and cancel/result races tested over SQL/HTTP and hosted runner | High; tenant/workflow review and migration authorization |
| P0: interrupted automation/self-improvement | #252 automation service/store; #243 verified-head merge; #266 cancel receipts | Existing #248/#242/#260 claims | Unknown starting mission paused rather than replayed; stale head/base approval refused; late result cannot resurrect cancellation; kill/restart and race tests | High for merge policy; protected review remains required |
| P1: shared inference quotas and budgets | `packages/atlas-inference/src`, hosted governor/client, CLI/local provider wrappers | #240 native streams, #200 CLI taxonomy, #230 local qualification; authenticated ledger boundary | Mixed hosted/local/runner concurrency cannot overspend; billing differs from 429; bounded retry/private fallback; stream/cancel/crash settle or expire reservation; real transport and ledger race tests | High; endpoint review and bounded model qualification budget; no GPU provisioning |
| P1: reliability acceptance missions | Verified coder, kernel/missions, Actions tasks and #236 manifests | Isolation, broker, idempotency first | Repeated real-model coding with provider refusal, process interruption and disconnect; actual checks/artifacts, independent review, no repeated consequential tool; cost per verified result | Medium/high; configured model budget; never substitute model statements for checks |
| P1: Genesis visual edit slice | #181; `platform/genesis/{service,executor,preview,inspector}.mjs`, UI selection/change requests | #74 ownership; rebase existing picker | Select element -> edit through real Genesis -> checks -> responsive preview; reject forged selection/path; actual CLI+Chromium. Then spacing/color/layout/delete/move/components separately | Medium/high; source/preview confinement review |
| P1: Team Hahn Construction acceptance | Genesis editable spec/history/templates/publisher; hosted `app/api/genesis/bridge.mjs` and operations API (#272) | Reachable trusted node or cloud worker, business facts/brand/domain and publish account | Requirements -> approved spec -> responsive design -> iterative repair/version comparison -> repository -> authorized deploy -> public health and artifact; actual browser review; no manual coding | High; owner business facts, account/domain and deployment authorization |
| P1: server-backed app deployment | Existing shared auth/database/files/secrets/jobs/queue templates and infrastructure/publisher tools | Scoped deploy broker, exact approval, execution host | Migrations, backups/restore, secrets, health and rollback; bad migration/release recovery tested; database-backed estimate endpoint verified | High; owner account/budget and protected review; no unapproved paid resources |
| P1: persistent LOCAL/CLOUD/HYBRID | Local kernel/session/task stores, hosted D1/events, Actions workers/artifacts | Execution fencing/isolation; durable external files/checkpoints/receipts and lease identity | Real coding mission completes with owner's computer disconnected; worker death resumes from durable evidence; stale lease stops work; resource caps and logs; sandbox failure never falls back unrestricted | High; owner storage/runner configuration and budget; no GPU needed |
| P2: cloud browser and takeover | Browser worker/computer APIs; #237 journal, #105 adapter, #61 mobile | Isolated cloud consumer, egress/approval controls and authenticated session artifacts | Real form workflow -> exact approval -> interruption/takeover -> hand-back -> fresh observe -> continuation; no auth/CAPTCHA/payment bypass or public profiles | High; protected review and hosted-browser configuration/budget |
| P2: shared multi-agent runtime/review | Kernel, missions/team/family graph/Command Center; registry/DAG libraries; #236 | Shared evidence/budgets and reliable tool receipts | Bounded roles; separate reviewer catches planted defect before release; individual/mission controls; measured quality/cost versus single agent | Medium/high; model budget, reviewer independence and protected release review |
| P2: approved connectors/skills | Existing MCP gateway/client and `platform/skills` package/registry/proposals/approvals | Capability boundary, signing, independent review, exact package approval | Gap -> proposal -> tested/reviewed signed package -> explicit install -> loaded tools; restart/tamper/revoke integration; no self-granted privileges | High; protected review and explicit installation authorization |
| P2: business estimate workflow | Genesis form/API/backend queue, scoped memory, opportunity scout #223 and authorized notification connector | Deployed app/database and business content | Test estimate stored once -> owner notified -> status tracked to completion; retry failures visible; SEO/GEO measured through indexing/performance/visibility/conversion | Medium/high; owner notification authorization and retention/account configuration |
| P2: customer-ready release | Setup/provider diagnosis, tenant/auth/repo routes, Windows installer/update, Capacitor; #203/#69/#77/#61 | Foundation and Genesis acceptance; billing only if offered | Fresh user completes real project; clean Windows install/update/rollback; mobile/keyboard usability, monitoring, permissions/retention; verified-only release claims | High; OAuth/native signing/optional Stripe owner setup and protected review |

Next engineering selection follows delivery of this audit. Validate/reconcile
the existing P0 boundary work first; diagnose the intermittent Windows startup
observation within current ownership. Do not count unmerged code or a normal inspection run as a completed
cloud coding, Genesis, browser or business acceptance mission.

---

# Historical production implementation queue — 2026-10-08

This queue supersedes the historical branch checkmarks below. The current
architecture inventory, existing capabilities, disconnected modules, PR
reconciliation and runtime evidence are in [ARCHITECTURE.md](ARCHITECTURE.md).
No completion percentage or duplicate TODO is used. Active claims are respected;
"owner review" means PROGRAM section 3 / CODEOWNERS, not another approval for
ordinary reversible engineering work.

## Production implementation queue — 2026-10-08

| Priority / task | Reuse and exact scope | Dependencies | Acceptance and required tests | Risk / owner intervention |
|---|---|---|---|---|
| P1: preserve chat reading position during output (#261; queued 2026-10-10) | `apps/web/app/chat/ChatSection.tsx`; replace unconditional output-driven `scrollIntoView` with user-controlled bottom following | Coordinate existing ChatSection owners (#240/#191/#101/#97); reuse current chat and scroll container | Scrolling up during streaming, thought/tool updates, suggestions or completion preserves the reading position on desktop and mobile; accessible Jump to latest resumes following; returning to bottom resumes normal follow; browser regressions cover conversation switching | Low/medium; owner-reported UX regression, queued rather than implemented |
| P0: finish credential/approval boundaries (existing #234/#235/#233 owners) | `apps/local-control/src/agent/tool-registry.mjs`, `platform/{executor,adapters,policy}.mjs`, vault and broker | Reconcile broker with adapter execution, owner review | Actual authenticated tool execution refuses expired/wrong-principal/context approval, cannot mint policy privileges, credentials absent from tool/model/receipts, late lookup after cancel cannot execute; SQLite concurrent consume + real HTTP + daemon journey + mutation guards | High; protected owner review required; do not duplicate active implementation |
| P0: reject unverified/stale self-improvement merges (#242/#243 owner) | `platform/self-improve/service.mjs`, existing candidate/approval stores | Exact verified commit + base digest, required CI | Changed candidate or base refused; only verified candidate promoted; failed reviewer/CI holds; real isolated-worktree tests | High; protected owner review required |
| P0: native Workers AI streaming/cancel reliability (#238/#240 owner) | `apps/web/app/api/chat/{agent-loop,providers,workers-ai-binding}.mjs`, current governor | Reconcile #233 binding and #241 continuation fixes | Real native SSE text/tools; reader cancel propagates; every reservation released; multi-round selected-provider hosted smoke; existing inference-chaos + provider gates | Medium/high; review owned provider/security changes, deployed provider access required |
| P1 immediate: recover cloud result callback (#244 claimed here) | `scripts/runner/report-result.mjs`, `report-result.test.mjs`; retain OIDC receiver `apps/web/app/api/tasks/result/route.ts` and stable IDs | Existing idempotent batch receiver; no new deployment service | Real HTTP reset and lost acknowledgement recover with identical bytes and <=3 attempts; retries bounded/backed off; permanent 4xx and redirects do not retry; safe error text; full runner/local suite and independent review | Low/medium; ordinary PR, no added spend or owner setup |
| P1: shared runner/hosted provider allowance | `packages/atlas-inference/src/`, `apps/web/app/api/inference/`, `worker/inference-governor*.mjs`, CLI provider wrappers | Authenticated rate-limited governor boundary; per-tenant scope and approved credential refs | Concurrent CLI+chat reservations cannot overspend; billing differs from 429; streams/cancel/worker death release or expire; no auth-free public ledger; integration over real transport + mixed-call failure injection | High; protected endpoint review, provider setup for live gate |
| P1: durable cloud coding continuation, first LOCAL/CLOUD/HYBRID slice | `src/agent/{runtime,session-store,mission-service}.mjs`, `src/agent/kernel/`, `platform/task-store.mjs`, Actions runner and hosted task/event APIs | Security fixes, durable external checkpoint/artifact store and worker identity | One approved cloud repo task persists goal/budget/tool receipts; lease loss kills stale worker; retry resumes completed evidence without rerunning mutation; phone/tab disconnect irrelevant; real worker kill/restart and idempotent-action tests | High; protected credentials/workflow review; owner must choose storage/runner account and budget, no GPU provision |
| P1: exact cloud dispatch outbox and recovery | `apps/web/app/api/tasks/route.ts`, local transactional outbox patterns, hosted task schema | Durable worker/task contract, idempotent dispatch attempt identity | Persist task before dispatch, reconcile accepted dispatch with failed persistence/ack; no orphaned task or duplicated coder mutation; real D1 transaction + crash/failure injection tests | High; protected tenant/auth review; coordinated migration |
| P1: atomic paid task caps (#203) and hosted API rate limits (#69) | `apps/web/app/api/billing/plan.mjs`, task usage, existing cap patch; existing D1 rate-limit patch | Current-base rebase; distinguish paid cap from security throttle | Concurrent submissions cannot exceed shared allowance or lose increments; stable Retry-After on hostile burst; account/IP isolation; real SQLite/D1 race tests | High; protected tenant/rate-limit review; Stripe owner setup before paid acceptance |
| P1: restore cloud browser consumer and takeover (#237/#105) | `apps/browser-worker/src/`, hosted `app/api/computer/`, local operator journal | Worker identity, isolation/egress, lease and artifact store; #237 Windows validation | Queued cloud browser task actually runs without PC; watch/take/handback/resume all authorized; browser continuity; mandatory fresh observation after handback; no profile/secret public endpoints; real Chromium + network + worker crash tests | High; protected egress/approval review and selected cloud host/budget |
| P2: Genesis visual editor (#74/#181 owner) | `platform/genesis/{preview,service,executor,inspector}.mjs`, existing static-site picker/source edit PR | Rebase existing text vertical slice, secure preview message mapping | Select known source element; edit text through real change request; repair verifies preview desktop/mobile; forged message/path rejected. Then spacing/color/delete/move/component variants separately; actual CLI+Chromium tests | Medium/high; review preview/source confinement; no duplicate template system |
| P2: hosted Genesis build/deploy | `platform/genesis/`, `agent/infrastructure/`, shared auth/files/secrets/jobs/queue templates | Cloud runtime, scoped deploy credentials, exact approval | Generate -> checks -> preview -> repair -> approved deployment -> production health, artifact and rollback evidence; failure-path integration, not provider stubs alone | High; owner deployment account, review and configured spend |
| P2: wire signed skills and capability-gap proposals | `platform/skills/{package,skill-registry,proposals,approvals}.mjs`, kernel `capabilities.mjs`, live ToolRegistry and MCP gateway | Exact package-digest approval, independent reviewer and test runner | Missing capability records proposal; signed package tested/reviewed; owner install approval bound to digest; approved tools loaded with narrowed permissions; revoke removes execution access; real daemon load/restart/tamper tests | High; protected skill approval review; explicit installation authorization |
| P2: evaluation/replay independent release gates (#128/#236 owner) | existing event/audit/replay modules, #236 manifests/benchmarks, Genesis regression scenarios | Stable run provenance, runtime/receipt boundaries | 30–50 real repo tasks graded by actual tests; failed and flaky baseline separated; side-effect-free replay cannot call live tools; reviewer independence; actual trace/eval artifact in release | Medium/high; owner review for protected release workflow changes; explicit model budget |
| P2: first external user onboarding/mobile (#61) | `/setup`, model diagnosis/settings, repository/tenant routes, `mobile/src/` and secure storage | Generic authorized cloud repository execution, tenant/member UI and revocable scoped identity | Fresh account -> configure model -> independent repo -> choose cloud -> coding -> observe -> exact approval -> verified result, tested on mobile widths and native shell; missing external setup explained truthfully | High; OAuth/GitHub App and optional Stripe owner configuration, native signing accounts |

## Immediate implementation evidence

#244 was selected only after code, open-PR file ownership and active issue
claims were checked. `report-result.mjs` is the workflow's real callback sender;
`deliverResult()` currently retries only HTTP 5xx. A fetch connection reset or
timeout escapes the loop. The receiver already validates signed OIDC run/task
identity and stores result/message with stable `result:task:run:attempt` IDs in
an idempotent batch. Reuse that design instead of introducing another queue or
credential. Baseline callback tests 5/5; runner/local scripts 63/63. Five regressions were
added first: all five failed against the original sender. The real HTTP fixture
commits a result then closes the socket before acknowledging it; the fixed sender
retries identical bytes, and the stable-ID fixture retains one accepted result.
The D1/OIDC receiver itself is unchanged and is not claimed as a live failure-
injection deployment test. Real reset exhaustion stops at three requests. Real
redirect refusal sends no credential to the destination. Timeout and permanent
4xx/configuration cases, fresh attempt signals and payload snapshots are covered.
After implementation: callback 10/10; runner/local scripts 68/68; syntax and
`git diff --check` clean. Guard mutations that disable retry classification or
re-serialize mutable evidence both fail, and restored focused tests pass. No
credentials, runner workflow, authorization or privileged infrastructure changed.

The shared `docs/PROGRESS.md` is edited by multiple active PRs. #244 records its
handoff in this existing queue and its issue/PR until those owners' changes are
integrated; no overlapping handoff edits are made here.

---

## Historical phased backlog (2026-09-24; retained for provenance)
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
